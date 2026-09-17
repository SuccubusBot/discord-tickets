const { pools } = require('../../../../../../lib/threads');
const { crypto } = pools;
const topics = new Map();

function decryptTopic(value) {
	if (!topics.has(value)) {
		// ponytail: bounded process-local cache; cold pages still pay Cryptr's key derivation cost.
		if (topics.size >= 512) topics.delete(topics.keys().next().value);
		const pending = Promise.resolve(crypto.queue(w => w.decrypt(value))).catch(error => {
			if (topics.get(value) === pending) topics.delete(value);
			throw error;
		});
		topics.set(value, pending);
	}
	return topics.get(value);
}

module.exports.get = fastify => ({
	handler: async req => {
		/** @type {import('client')} */
		const client = req.routeOptions.config.client;
		const { query } = req;
		const tickets = await client.prisma.ticket.findMany({
			orderBy: { number: query.after ? 'asc' : 'desc' },
			select: {
				createdAt: true,
				createdById: true,
				id: true,
				lastMessageAt: true,
				number: true,
				open: true,
				topic: true,
			},
			take: query.limit,
			where: {
				createdAt: { gte: query.since && new Date((Number(query.since) * 1000) || query.since) },
				guildId: req.params.guild,
				number: query.before ? { lt: query.before } : query.after ? { gt: query.after } : undefined,
				open: query.status === 'open' ? true : query.status === 'closed' ? false : undefined,
			},
		});
		if (query.after) tickets.reverse();
		return Promise.all(
			tickets.map(async ticket => {
				ticket.topic &&= await decryptTopic(ticket.topic);
				return ticket;
			}),
		);
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
	schema: {
		querystring: {
			not: { required: ['before', 'after'] },
			properties: {
				after: {
					maximum: 2147483647,
					minimum: 1,
					type: 'integer',
				},
				before: {
					maximum: 2147483647,
					minimum: 1,
					type: 'integer',
				},
				limit: {
					default: 25,
					maximum: 100,
					minimum: 1,
					type: 'integer',
				},
				since: { type: 'string' },
				status: {
					default: 'all',
					enum: ['all', 'open', 'closed'],
					type: 'string',
				},
			},
			type: 'object',
		},
	},
});
