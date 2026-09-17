const { pools } = require('../threads');
const { saveAttachment } = require('./attachments');

const { crypto } = pools;

/**
 * Returns highest (roles.highest) hoisted role, or everyone
 * @param {import("discord.js").GuildMember} member
 * @returns {import("discord.js").Role}
 */
const hoistedRole = member => member.roles.hoist || member.guild.roles.everyone;

module.exports = class TicketArchiver {
	constructor(client) {
		/** @type {import("client")} */
		this.client = client;
		this.pending = new Map();
	}

	queue(id, run) {
		const task = (this.pending.get(id) || Promise.resolve()).catch(() => {}).then(run);
		this.pending.set(id, task);
		return task.finally(() => {
			if (this.pending.get(id) === task) this.pending.delete(id);
		});
	}

	saveMessage(ticketId, message, external = false) {
		// Snapshot before queued work: Discord may mutate the cached message during an edit.
		const snapshot = {
			attachments: [...message.attachments.values()].map(attachment => attachment.toJSON?.() || { ...attachment }),
			components: message.components.map(component => component.toJSON()),
			content: message.content,
			editedAt: message.editedAt?.toISOString() || null,
			embeds: message.embeds.map(embed => embed.toJSON()),
			reference: message.reference?.messageId ?? null,
		};
		return this.queue(message.id, () => this.persistMessage(ticketId, message, external, snapshot));
	}

	markDeleted(ticketId, message) {
		return this.queue(message.id, async () => {
			if (process.env.OVERRIDE_ARCHIVE === 'false') return;
			await this.client.prisma.archivedMessage.updateMany({
				data: { deleted: true },
				where: {
					id: message.id,
					ticketId,
				},
			});
		});
	}

	/** Add or update a message
	 * @param {string} ticketId
	 * @param {import("discord.js").Message} message
	 * @param {boolean?} external
	 * @returns {import("@prisma/client").ArchivedMessage|boolean}
	 */
	async persistMessage(ticketId, message, external, snapshot) {
		if (process.env.OVERRIDE_ARCHIVE === 'false') return false;

		if (!message.member) {
			try {
				message.member = await message.guild.members.fetch(message.author.id);
			} catch {
				this.client.log.verbose('Failed to fetch member %s of %s', message.author.id, message.guild.id);
			}
		}

		const channels = new Set(message.mentions.channels.values());
		const members = new Set(message.mentions.members.values());
		const roles = new Set(message.mentions.roles.values());

		try {
			const queries = [];

			if (message.member) members.add(message.member);

			for (const member of members) {
				roles.add(hoistedRole(member));
			}

			for (const role of roles) {
				const data = {
					colour: role.hexColor.slice(1),
					name: role.name,
				};
				queries.push(
					this.client.prisma.archivedRole.upsert({
						create: {
							...data,
							roleId: role.id,
							ticketId,
						},
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_roleId: {
								roleId: role.id,
								ticketId,
							},
						},
					}),
				);
			}

			for (const member of members) {
				const data = {
					avatar: member.avatar || member.user.avatar, // TODO: save avatar in user/avatars/
					bot: member.user.bot,
					discriminator: member.user.discriminator,
					displayName: member.displayName ? await crypto.queue(w => w.encrypt(member.displayName)) : null,
					roleId: !!member && hoistedRole(member).id,
					username: await crypto.queue(w => w.encrypt(member.user.username)),
				};
				queries.push(
					this.client.prisma.archivedUser.upsert({
						create: {
							...data,
							ticketId,
							userId: member.user.id,
						},
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_userId: {
								ticketId,
								userId: member.user.id,
							},
						},
					}),
				);
			}

			for (const channel of channels) {
				const data = {
					channelId: channel.id,
					name: channel.name,
					ticketId,
				};
				queries.push(
					this.client.prisma.archivedChannel.upsert({
						create: data,
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_channelId: {
								channelId: channel.id,
								ticketId,
							},
						},
					}),
				);
			}

			if (!message.member) {
				const user = message.author;
				const data = {
					avatar: user.avatar,
					bot: user.bot,
					discriminator: user.discriminator,
					username: await crypto.queue(w => w.encrypt(user.username)),
				};
				queries.push(this.client.prisma.archivedUser.upsert({
					create: {
						...data,
						ticketId,
						userId: user.id,
					},
					update: data,
					where: {
						ticketId_userId: {
							ticketId,
							userId: user.id,
						},
					},
				}));
			}

			const previous = await this.client.prisma.archivedMessage.findUnique({ where: { id: message.id } });
			if (previous?.content) {
				const {
					revisions = [], ...original
				} = JSON.parse(await crypto.queue(w => w.decrypt(previous.content)));
				snapshot.revisions = revisions;
				const {
					revisions: _ignored, ...current
				} = snapshot;
				if (JSON.stringify(original) !== JSON.stringify(current)) snapshot.revisions.push(original);
			}
			const data = {
				content: await crypto.queue(w => w.encrypt(JSON.stringify(snapshot))),
				createdAt: message.createdAt,
				edited: !!snapshot.editedAt || previous?.edited || false,
				external,
			};

			queries.push(
				this.client.prisma.archivedMessage.upsert({
					create: {
						...data,
						authorId: message.author?.id || 'default',
						id: message.id,
						ticketId,
					},
					select: { ticketId: true },
					update: data,
					where: { id: message.id },
				}),
			);

			const result = await this.client.prisma.$transaction(queries);
			for (const attachment of snapshot.attachments) {
				try {
					await saveAttachment(message.guild.id, ticketId, message.id, attachment);
				} catch (error) {
					this.client.log.warn('Failed to store attachment %s on message %s: %s', attachment.id, message.id, error.message);
				}
			}
			return result;
		} catch (error) {
			this.client.log.error('Failed to archive message %s', message.id);
			this.client.log.error(error);
			return false;
		}
	}
};
