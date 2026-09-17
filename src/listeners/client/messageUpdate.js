const { Listener } = require('@eartharoid/dbf');
const { MessageFlags } = require('discord.js');
const { logMessageEvent } = require('../../lib/logging');

module.exports = class extends Listener {
	constructor(client, options) {
		super(client, {
			...options,
			emitter: client,
			event: 'messageUpdate',
		});
	}


	/**
	 * @param {import("discord.js").Message} oldMessage
	 * @param {import("discord.js").Message} newMessage
	 */
	async run(oldMessage, newMessage) {
		/** @type {import("client")} */
		const client = this.client;

		if (newMessage.partial) {
			try {
				newMessage = await newMessage.fetch();
			} catch (error) {
				client.log.error(error);
				return;
			}
		}

		if (!newMessage.guild) return;
		if (newMessage.flags.has(MessageFlags.Ephemeral)) return;

		const ticket = await client.prisma.ticket.findUnique({
			include: { guild: true },
			where: { id: newMessage.channel.id },
		});
		if (!ticket) return;

		if (ticket.guild.archive) {
			try {
				if (!oldMessage.partial) {
					const archived = await client.prisma.archivedMessage.findUnique({ where: { id: newMessage.id } });
					if (!archived) await client.tickets.archiver.saveMessage(ticket.id, oldMessage);
				}
				await client.tickets.archiver.saveMessage(ticket.id, newMessage);
			} catch (error) {
				client.log.warn('Failed to update archived message', newMessage.id);
				client.log.error(error);
				newMessage.react('❌').catch(client.log.error);
			}
		}

		if (newMessage.author.id === client.user.id || !newMessage.editedAt || oldMessage.content === newMessage.content) return;

		await logMessageEvent(this.client, {
			action: 'update',
			diff: {
				original: { content: oldMessage.cleanContent },
				updated: { content: newMessage.cleanContent },
			},
			target: newMessage,
			ticket,
		});
	}
};
