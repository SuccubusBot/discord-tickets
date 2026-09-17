const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const Fastify = require('fastify');

// Keep Discord and production databases out of this check; exercise the real archive and HTTP handlers.
require.cache[require.resolve('../src/lib/threads')] = {
	exports: {
		pools: {
			crypto: {
				queue: async run => run({
					decrypt: value => value,
					encrypt: value => value,
				}),
			},
		},
	},
};
const Archiver = require('../src/lib/tickets/archiver');
const {
	saveAttachment, readAttachment,
} = require('../src/lib/tickets/attachments');
const route = require('../src/routes/api/admin/guilds/[guild]/tickets/[ticket]/messages/[message]/attachments/[attachment]');
const guild = '997372719555412008';
const ticket = '997372719555412009';
const messageId = '997372719555412010';
const fileId = '997372719555412011';
const originalFetch = global.fetch;
const originalDirectory = process.cwd();
const records = new Map();
let downloads = 0;
const payload = Buffer.from('archived file bytes');
const attachment = {
	id: fileId,
	name: 'evidence.txt',
	url: `https://cdn.discordapp.com/attachments/${ticket}/${fileId}/evidence.txt?ex=expired`,
};
const writes = { upsert: () => async () => {} };
const client = {
	log: {
		error: error => {
			throw error instanceof Error ? error : new Error(error);
		},
		verbose: () => {},
		warn: () => {},
	},
	prisma: {
		$transaction: async queries => {
			for (const query of queries) await query();
		},
		archivedChannel: writes,
		archivedMessage: {
			findFirst: async ({ where }) => where.ticket.guildId === guild && where.ticketId === ticket
				? structuredClone(records.get(where.id)) : null,
			findUnique: async ({ where }) => structuredClone(records.get(where.id)),
			updateMany: async ({
				data, where,
			}) => {
				if (records.get(where.id)?.ticketId === where.ticketId) Object.assign(records.get(where.id), data);
			},
			upsert: ({
				create, update, where,
			}) => async () => {
				records.set(where.id, records.has(where.id) ? {
					...records.get(where.id),
					...update,
				} : create);
			},

		},
		archivedRole: writes,
		archivedUser: writes,
	},
};
const message = {
	attachments: new Map([[fileId, attachment]]),
	author: {
		id: '997372719555412012',
		username: 'Test user',
	},
	components: [],
	content: 'Original',
	createdAt: new Date('2026-09-17T00:00:00Z'),
	embeds: [{ toJSON: () => ({ title: 'Embed title' }) }],
	guild: {
		id: guild,
		members: {
			fetch: async () => {
				throw new Error('Member left');
			},
		},
	},
	id: messageId,
	mentions: {
		channels: new Map(),
		members: new Map(),
		roles: new Map(),
	},
};

(async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), 'tickets-archive-check-'));
	const api = Fastify();
	try {
		process.chdir(temporary);
		process.env.ENCRYPTION_KEY = randomBytes(24).toString('hex');
		delete process.env.OVERRIDE_ARCHIVE;
		global.fetch = async () => {
			downloads++;
			return new Response(payload);
		};
		const archiver = new Archiver(client);
		// Enqueue edits and deletion before the initial archive finishes.
		await Promise.all([
			archiver.saveMessage(ticket, message),
			archiver.saveMessage(ticket, {
				...message,
				content: 'First edit',
				editedAt: new Date('2026-09-17T00:01:00Z'),
			}),
			archiver.saveMessage(ticket, {
				...message,
				attachments: new Map(),
				content: 'Second edit',
				editedAt: new Date('2026-09-17T00:02:00Z'),
			}),
			archiver.markDeleted(ticket, message),
		]);
		const stored = records.get(messageId);
		assert.equal(stored.deleted, true);
		assert.equal(stored.edited, true);
		const content = JSON.parse(stored.content);
		assert.equal(content.content, 'Second edit');
		assert.deepEqual(content.revisions.map(version => version.content), ['Original', 'First edit']);
		assert.equal(content.embeds[0].title, 'Embed title');
		assert.equal(content.revisions[0].attachments[0].id, fileId);
		assert.equal(downloads, 1, 'Repeated archive updates must not redownload stored files');
		const encryptedPath = join(temporary, 'user', 'attachments', guild, ticket, messageId, `${fileId}.bin`);
		assert.equal((await fs.readFile(encryptedPath)).includes(payload), false);
		const stream = await readAttachment(guild, ticket, messageId, fileId);
		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);
		assert.deepEqual(Buffer.concat(chunks), payload);
		await assert.rejects(saveAttachment('../outside', ticket, messageId, attachment), /identifier/);
		await assert.rejects(saveAttachment(guild, ticket, messageId, {
			...attachment,
			id: '997372719555412099',
			url: 'http://127.0.0.1/private',
		}), /URL/);
		assert.equal(downloads, 1, 'Invalid URLs must never be fetched');

		api.decorate('authenticate', async (req, res) => {
			if (!req.headers.cookie) return res.code(401).send();
		});
		api.decorate('isAdmin', async (req, res) => {
			if (req.headers.cookie !== 'admin') return res.code(403).send();
		});
		api.route({
			...route.get(api),
			config: { client },
			method: 'GET',
			url: '/api/admin/guilds/:guild/tickets/:ticket/messages/:message/attachments/:attachment',
		});
		const url = `/api/admin/guilds/${guild}/tickets/${ticket}/messages/${messageId}/attachments/${fileId}`;
		assert.equal((await api.inject({ url })).statusCode, 401);
		assert.equal((await api.inject({
			headers: { cookie: 'member' },
			url,
		})).statusCode, 403);
		assert.equal((await api.inject({
			headers: { cookie: 'admin' },
			url: url.replace(guild, '997372719555412099'),
		})).statusCode, 404);
		const response = await api.inject({
			headers: { cookie: 'admin' },
			url,
		});
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.rawPayload, payload);
		assert.equal(response.headers['cache-control'], 'private, no-store');
		assert.match(response.headers['content-disposition'], /evidence.txt/);
		// A deleted source cannot be recovered, so report this explicitly.
		global.fetch = async () => new Response('', { status: 404 });
		const absentId = '997372719555412099';
		content.attachments.push({
			...attachment,
			id: absentId,
			url: attachment.url.replace(fileId, absentId),
		});
		records.get(messageId).content = JSON.stringify(content);
		client.channels = {
			fetch: async () => {
				throw new Error('Deleted channel');
			},
		};
		assert.equal((await api.inject({
			headers: { cookie: 'admin' },
			url: url.replace(fileId, absentId),
		})).statusCode, 410);
		// Refreshing an extant Discord message recovers the expired URL and saves a durable copy.
		client.channels.fetch = async () => ({
			guildId: guild,
			messages: {
				fetch: async () => ({
					attachments: new Map([[absentId, {
						...attachment,
						id: absentId,
						url: attachment.url.replace(fileId, absentId).replace('expired', 'fresh'),
					}]]),
				}),
			},
		});
		global.fetch = async requested => String(requested).includes('fresh') ? new Response(payload) : new Response('', { status: 404 });
		assert.equal((await api.inject({
			headers: { cookie: 'admin' },
			url: url.replace(fileId, absentId),
		})).statusCode, 200);
		global.fetch = async () => {
			throw new Error('Must use the saved copy');
		};
		assert.deepEqual((await api.inject({
			headers: { cookie: 'admin' },
			url: url.replace(fileId, absentId),
		})).rawPayload, payload);

		// Audit-log permission failures must not prevent deletion markers.
		require.cache[require.resolve('../src/lib/logging')] = { exports: { logMessageEvent: async () => {} } };
		const Deleted = require('../src/listeners/client/messageDelete');
		const BulkDeleted = require('../src/listeners/client/messageDeleteBulk');
		client.prisma.ticket = {
			findUnique: async () => ({
				guild: { archive: true },
				id: ticket,
			}),
		};
		client.tickets = { archiver };
		client.user = { id: message.author.id };
		message.channel = { id: ticket };
		message.guild.fetchAuditLogs = async () => {
			throw new Error('Missing audit permission');
		};
		stored.deleted = false;
		await Deleted.prototype.run.call({ client }, message);
		assert.equal(stored.deleted, true);
		stored.deleted = false;
		await BulkDeleted.prototype.run.call({ client }, new Map([[messageId, message]]), message.channel);
		assert.equal(stored.deleted, true);

		const corrupted = await fs.readFile(encryptedPath);
		corrupted[corrupted.length - 1] ^= 1;
		await fs.writeFile(encryptedPath, corrupted);
		await assert.rejects(async () => {
			for await (const chunk of await readAttachment(guild, ticket, messageId, fileId)) assert.ok(Buffer.isBuffer(chunk));
		});
		process.stdout.write('archive checks: revisions, deletion ordering, encrypted attachment storage, access controls and unavailable files passed\n');
	} finally {
		global.fetch = originalFetch;
		process.chdir(originalDirectory);
		await api.close();
		await fs.rm(temporary, {
			force: true,
			recursive: true,
		});
	}
})().catch(error => {
	process.stderr.write(String(error.stack || error) + '\n');
	process.exitCode = 1;
});
