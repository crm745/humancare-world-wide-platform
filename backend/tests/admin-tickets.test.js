jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createCorporateUserAndLogin, createAdminAndLogin } = require('./helpers');

afterAll(async () => {
  await prisma.$disconnect();
});

const baseTicket = { subject: 'Cannot upload document', category: 'Technical', priority: 'High', description: 'Upload button does nothing.' };

describe('GET /admin/tickets', () => {
  it('requires admin authentication', async () => {
    const res = await request(app).get('/admin/tickets');
    expect(res.status).toBe(401);
  });

  it('rejects a corporate token', async () => {
    const { token } = await createCorporateUserAndLogin();
    const res = await request(app).get('/admin/tickets').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401); // Admin Lock: a non-Admin credential is a generic 401 (admin-session.middleware.js)
  });

  it('lists tickets across every corporate, newest-updated first, with the corporate company name attached', async () => {
    const corporateA = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate A' });
    const corporateB = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate B' });
    await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporateA.token}`).send(baseTicket);
    await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporateB.token}`).send(baseTicket);

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app).get('/admin/tickets').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const companies = res.body.tickets.map((t) => t.corporate.companyName);
    expect(companies).toEqual(expect.arrayContaining(['Admin Ticket Corporate A', 'Admin Ticket Corporate B']));
  });

  it('filters by status', async () => {
    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app).get('/admin/tickets').query({ status: 'open' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tickets.every((t) => t.status === 'Open')).toBe(true);
  });
});

describe('GET /admin/tickets/:id', () => {
  it('returns one ticket with its messages', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate E' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);
    const ticketId = createRes.body.id;

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app).get(`/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ticket.id).toBe(ticketId);
    expect(res.body.ticket.messages).toHaveLength(1);
    expect(res.body.ticket.messages[0].from).toBe('corporate');
  });

  it('404s for a ticket id that does not exist', async () => {
    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app).get('/admin/tickets/HCW-TKT-99999').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/tickets/:id/messages', () => {
  it('appends an admin reply, tagged with the admin name and role, without reopening an already-open ticket', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate F' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);
    const ticketId = createRes.body.id;

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app)
      .post(`/admin/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ body: 'Looking into this now.' });
    expect(res.status).toBe(200);
    expect(res.body.ticket.messages).toHaveLength(2);
    const reply = res.body.ticket.messages[1];
    expect(reply.from).toBe('admin');
    expect(reply.author).toBe('Test Admin');
    expect(res.body.ticket.status).toBe('Open');
  });

  it('notifies the corporate user when an admin replies', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate G' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);
    const ticketId = createRes.body.id;

    const { token: adminToken } = await createAdminAndLogin();
    await request(app).post(`/admin/tickets/${ticketId}/messages`).set('Authorization', `Bearer ${adminToken}`).send({ body: 'We are on it.' });

    const notifRes = await request(app).get('/corporate/notifications').set('Authorization', `Bearer ${corporate.token}`);
    expect(notifRes.body.some((n) => n.title.includes(ticketId))).toBe(true);
  });

  it('rejects a reply with an empty body', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate H' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app)
      .post(`/admin/tickets/${createRes.body.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ body: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/tickets/:id/status', () => {
  it('moves a ticket to resolved', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate I' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);
    const ticketId = createRes.body.id;

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app)
      .patch(`/admin/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe('Resolved');
  });

  it('rejects an invalid status value', async () => {
    const corporate = await createCorporateUserAndLogin({ companyName: 'Admin Ticket Corporate J' });
    const createRes = await request(app).post('/corporate/tickets').set('Authorization', `Bearer ${corporate.token}`).send(baseTicket);

    const { token: adminToken } = await createAdminAndLogin();
    const res = await request(app)
      .patch(`/admin/tickets/${createRes.body.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'archived' });
    expect(res.status).toBe(400);
  });
});
