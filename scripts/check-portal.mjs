import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
	[`/api/admin/guilds/${guildId}/tickets`]: [ticket],
	[`/api/admin/guilds/${guildId}/tickets/${ticketId}`]: ticket,
};
const requests = [];
let handler;
const server = createServer((req, res) => {
	if (!req.url.startsWith('/api/')) return handler(req, res);
	requests.push(req.url);
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
	createRequire(import.meta.url)('../src/http.js');
	({ handler } = await import('@discord-tickets/settings/build/handler.js'));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const paths = [
		`/${guildId}/tickets`,
		`/${BigInt(guildId).toString(36)}/tickets`,
		`/transcripts/${guildId}/${ticketId}`,
	];
	for (const path of paths) {
		requests.length = 0;
		const response = await fetch(origin + path, {
			headers: { cookie: 'token=test-session; locale=en-GB; theme=dark' },
			redirect: 'manual',
		});
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}`);
		assert.ok(requests.includes(`/api/guilds/${guildId}`), path);
		assert.ok(requests.some(url => url.startsWith(`/api/admin/guilds/${guildId}/tickets`)), path);
	}
	const anonymous = await fetch(origin + paths[0], { redirect: 'manual' });
	assert.equal(anonymous.status, 307);
	assert.match(anonymous.headers.get('location'), /^\/login\?.*role=admin/);
} finally {
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
