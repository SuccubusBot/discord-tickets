const { Listener } = require('@eartharoid/dbf');

module.exports = class extends Listener {
	constructor(client, options) {
		super(client, {
			...options,
			emitter: client,
			event: 'messageDeleteBulk',
		});
	}

	async run(messages, channel) {
		const ticket = await this.client.prisma.ticket.findUnique({
			include: { guild: true },
			where: { id: channel.id },
		});
		if (!ticket?.guild.archive) return;
		await Promise.all([...messages.values()].map(async message => {
			const existing = await this.client.prisma.archivedMessage.findUnique({ where: { id: message.id } });
			if (!existing && !message.partial) await this.client.tickets.archiver.saveMessage(ticket.id, message);
			await this.client.tickets.archiver.markDeleted(ticket.id, message);
		}));
	}
};
