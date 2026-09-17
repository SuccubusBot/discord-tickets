const {
	Message, Routes,
} = require('discord.js');

module.exports.post = fastify => ({
	handler: async (req, res) => {
		const client = req.routeOptions.config.client;
		const {
			guild, ticket: id,
		} = req.params;
		const ticket = await client.prisma.ticket.findUnique({
			include: { guild: { select: { archive: true } } },
			where: {
				guildId: guild,
				id,
			},
		});
		if (!ticket) return res.code(404).send({ message: 'Ticket not found.' });
		if (!ticket.guild.archive || process.env.OVERRIDE_ARCHIVE === 'false') {
			return res.code(409).send({ message: 'Archiving is disabled for this server.' });
		}
		if (!ticket.openingMessageId) return res.code(410).send({ message: 'No opening message was recorded for this ticket.' });
		const existing = await client.prisma.archivedMessage.findUnique({ where: { id: ticket.openingMessageId } });
		if (existing) return res.code(204).send();

		let message;
		try {
			const signal = AbortSignal.timeout(10000);
			const channel = await client.rest.get(Routes.channel(id), { signal });
			if (channel.guild_id !== guild) return res.code(404).send({ message: 'Ticket channel not found.' });
			const data = await client.rest.get(Routes.channelMessage(id, ticket.openingMessageId), { signal });
			message = new Message(client, {
				...data,
				guild_id: guild,
			});
		} catch (error) {
			const missing = [10003, 10008].includes(error.code);
			return res.code(missing ? 410 : 503).send({
				message: missing
					? 'The original opening message is no longer available from Discord.'
					: 'Could not read the opening message from Discord. Check bot permissions and try again.',
			});
		}
		if (await client.tickets.archiver.saveMessage(id, message) === false) {
			return res.code(500).send({ message: 'The opening message could not be saved. Please try again.' });
		}
		return res.code(204).send();
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
	schema: {
		params: {
			properties: Object.fromEntries(['guild', 'ticket'].map(key => [key, {
				pattern: '^\\d{16,20}$',
				type: 'string',
			}])),
			required: ['guild', 'ticket'],
			type: 'object',
		},
	},
});
