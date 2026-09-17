import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { manifest } from '@discord-tickets/settings/build/server/manifest.js';

for (const id of ['/(default)/[guild]/tickets', '/(default)/transcripts/[guild]/[ticket]']) {
	const route = manifest._.routes.find(route => route.id === id);
	assert.ok(route?.page, `Missing portal page: ${id}`);
	const page = await manifest._.nodes[route.page.leaf]();
	assert.equal(typeof page.universal.load, 'function');
	await page.component();
}

const guildId = '997372719555412008';
const ticketId = '997372719555412009';
const ticket = {
	archivedMessages: [],
	archivedRoles: [],
	archivedUsers: [],
	createdAt: '2026-09-17T00:00:00Z',
	id: ticketId,
	number: 1,
	open: false,
	questionAnswers: [],
	topic: 'Test ticket',
};
const tickets = Array.from({ length: 60 }, (_, index) => ({
	...ticket,
	id: String(BigInt(ticketId) + BigInt(index)),
	number: index + 1,
	open: index % 2 === 1,
}));
const fixtures = {
	'/api/client': { username: 'Test bot' },
	'/api/users/@me': {
		locale: 'en-GB',
		username: 'Test user',
	},
	[`/api/guilds/${guildId}`]: {
		id: guildId,
		name: 'Test guild',
	},
	...Object.fromEntries(tickets.map(ticket => [`/api/admin/guilds/${guildId}/tickets/${ticket.id}`, ticket])),
};
const require = createRequire(import.meta.url);
let decrypted = 0;
require.cache[require.resolve('../src/lib/threads')] = {
	exports: {
		pools: {
			crypto: {
				queue: async run => run({
					decrypt: value => {
						decrypted++;
						return value.replace('encrypted:', '');
					},
				}),
			},
		},
	},
};
const api = Fastify();
api.decorate('authenticate', async (req, res) => {
	if (!req.headers.cookie?.includes('token=test-session')) return res.code(401).send({ message: 'Unauthorised' });
});
api.decorate('isAdmin', async () => {});
async function findMany({
	where, orderBy, select, take,
}) {
	assert.equal(where.guildId, guildId);
	assert.ok(take >= 1 && take <= 100, 'Ticket queries must be bounded');
	assert.equal(select.closedReason, undefined, 'The list must not decrypt closure reasons');
	return tickets
		.filter(ticket => (!where.number?.lt || ticket.number < where.number.lt) &&
			(!where.number?.gt || ticket.number > where.number.gt) &&
			(where.open === undefined || ticket.open === where.open))
		.sort((a, b) => orderBy.number === 'asc' ? a.number - b.number : b.number - a.number)
		.slice(0, take)
		.map(ticket => Object.fromEntries(Object.keys(select).map(key => [key, key === 'topic' ? `encrypted:${ticket.topic}` : ticket[key]])));
}
api.route({
	...require('../src/routes/api/admin/guilds/[guild]/tickets/index.js').get(api),
	config: { client: { prisma: { ticket: { findMany } } } },
	method: 'GET',
	url: '/api/admin/guilds/:guild/tickets',
});
const requests = [];
let handler;
const server = createServer(async (req, res) => {
	if (!req.url.startsWith('/api/')) return handler(req, res);
	requests.push(req.url);
	const path = new URL(req.url, 'http://localhost').pathname;
	if (path === `/api/admin/guilds/${guildId}/tickets`) {
		const response = await api.inject({
			headers: req.headers,
			method: 'GET',
			url: req.url,
		});
		res.writeHead(response.statusCode, response.headers).end(response.body);
		return;
	}
	res.setHeader('content-type', 'application/json');
	if (!req.headers.cookie?.includes('token=test-session')) {
		res.writeHead(401).end(JSON.stringify({ message: 'Unauthorised' }));
	} else if (fixtures[req.url]) {
		res.end(JSON.stringify(fixtures[req.url]));
	} else {
		res.writeHead(404).end(JSON.stringify({ message: `Unknown fixture: ${req.url}` }));
	}
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
	process.env.HTTP_HOST = '0.0.0.0';
	process.env.HTTP_PORT = String(server.address().port);
	process.env.HTTP_EXTERNAL = 'http://127.0.0.1:1'; // Public ingress is unreachable from this process.
	delete process.env.HTTP_INTERNAL;
	require('../src/http.js');
	({ handler } = await import('@discord-tickets/settings/build/handler.js'));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const paths = [
		`/${guildId}/tickets`,
		`/${BigInt(guildId).toString(36)}/tickets`,
		`/${guildId}/tickets?before=36`,
		`/${guildId}/tickets?after=35`,
		`/${guildId}/tickets?status=closed`,
		`/transcripts/${guildId}/${ticketId}`,
	];
	for (const path of paths) {
		requests.length = 0;
		decrypted = 0;
		const response = await fetch(origin + path, {
			headers: { cookie: 'token=test-session; locale=en-GB; theme=dark' },
			redirect: 'manual',
		});
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}`);
		assert.match(body, /<main\b/, `${path}: page content must render before JavaScript runs`);
		const number = path.includes('transcripts') ? 1 : path.includes('before=36') ? 35 : path.includes('status=closed') ? 59 : 60;
		assert.ok(body.includes(`Ticket #${number}`), `${path}: ticket content is missing`);
		assert.ok(decrypted <= 26, `${path}: too many topics decrypted`);
		assert.ok(requests.includes(`/api/guilds/${guildId}`), path);
		assert.ok(requests.some(url => url.startsWith(`/api/admin/guilds/${guildId}/tickets`)), path);
	}
	const anonymous = await fetch(origin + paths[0], { redirect: 'manual' });
	assert.equal(anonymous.status, 307);
	assert.match(anonymous.headers.get('location'), /^\/login\?.*role=admin/);
	for (const query of ['limit=101', 'limit=0', 'before=-1', 'before=10&after=20', 'status=invalid']) {
		const response = await api.inject({
			headers: { cookie: 'token=test-session' },
			url: `/api/admin/guilds/${guildId}/tickets?${query}`,
		});
		assert.equal(response.statusCode, 400, query);
	}
	const firstPage = await api.inject({
		headers: { cookie: 'token=test-session' },
		url: `/api/admin/guilds/${guildId}/tickets`,
	});
	assert.equal(firstPage.json().length, 25, 'Default API requests must be bounded');
} finally {
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	await api.close();
}
