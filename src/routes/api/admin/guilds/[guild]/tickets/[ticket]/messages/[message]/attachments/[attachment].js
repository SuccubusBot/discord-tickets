const { pools } = require('../../../../../../../../../../lib/threads');
const {
	readAttachment, saveAttachment,
} = require('../../../../../../../../../../lib/tickets/attachments');

module.exports.get = fastify => ({
	handler: async (req, res) => {
		const client = req.routeOptions.config.client;
		const {
			guild, ticket, message, attachment,
		} = req.params;
		const archived = await client.prisma.archivedMessage.findFirst({
			where: {
				id: message,
				ticket: { guildId: guild },
				ticketId: ticket,
			},
		});
		if (!archived) return res.code(404).send({ message: 'Attachment not found' });
		const content = JSON.parse(await pools.crypto.queue(w => w.decrypt(archived.content)));
		const metadata = [content, ...(content.revisions || [])]
			.flatMap(version => version.attachments || []).find(file => file.id === attachment);
		if (!metadata) return res.code(404).send({ message: 'Attachment not found' });
		let stream;
		try {
			stream = await readAttachment(guild, ticket, message, attachment);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			try {
				try {
					await saveAttachment(guild, ticket, message, metadata);
				} catch {
					// Existing Discord messages can supply a fresh signed URL for legacy archives.
					const channel = await client.channels.fetch(ticket);
					if (channel?.guildId !== guild) throw new Error('Ticket channel unavailable');
					const live = await channel.messages.fetch(message);
					const file = live.attachments.get(attachment);
					if (!file) throw new Error('Original attachment unavailable');
					await saveAttachment(guild, ticket, message, file);
				}
				stream = await readAttachment(guild, ticket, message, attachment);
			} catch (failure) {
				client.log.warn('Attachment %s is unavailable: %s', attachment, failure.message);
				return res.code(410).send({ message: 'This file was not saved and is no longer available from Discord.' });
			}
		}
		res.header('Cache-Control', 'private, no-store');
		res.header('X-Content-Type-Options', 'nosniff');
		res.header('Content-Disposition', `attachment; filename="attachment-${attachment}"; filename*=UTF-8''${encodeURIComponent(metadata.name || metadata.filename || `attachment-${attachment}`)}`);
		return res.type('application/octet-stream').send(stream);
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
	schema: {
		params: {
			properties: Object.fromEntries(['guild', 'ticket', 'message', 'attachment'].map(key => [key, {
				pattern: '^\\d{16,20}$',
				type: 'string',
			}])),
			required: ['guild', 'ticket', 'message', 'attachment'],
			type: 'object',
		},
	},
});
