const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const Task = require('../models/Task');
const User = require('../models/User');
const { getBucket } = require('../config/uploads');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

// A supervisor, one intern and one open task between them
async function setup() {
  const admin = await makeAdmin(app);
  const intern = await makeIntern(app);
  const task = await Task.create({
    title: 'Write the report', description: 'd', dueDate: '2099-01-01',
    assignedTo: intern.user._id, createdBy: admin.user._id,
  });
  return { admin, intern, task };
}

const submit = (intern, taskId, link = 'https://github.com/example/repo') =>
  intern.agent.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', intern.csrfToken).field('link', link);

describe('submission upload cleanup', () => {
  const makeCfb = (streamName) => {
    const cfb = Buffer.alloc(1536);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
    cfb.writeUInt16LE(3, 26); // version 3
    cfb.writeUInt16LE(0xfffe, 28); // little endian
    cfb.writeUInt16LE(9, 30); // 512-byte sectors
    cfb.writeUInt32LE(1, 44); // one FAT sector
    cfb.writeUInt32LE(1, 48); // directory starts in sector 1
    cfb.writeUInt32LE(0, 76); // FAT is sector 0
    cfb.writeUInt32LE(0xfffffffd, 512); // FAT sector marker
    cfb.writeUInt32LE(0xfffffffe, 516); // end of directory chain
    if (streamName) {
      const entry = 1024;
      const encoded = Buffer.from(`${streamName}\0`, 'utf16le');
      encoded.copy(cfb, entry);
      cfb.writeUInt16LE(encoded.length, entry + 64);
      cfb[entry + 66] = 2; // stream directory entry
    }
    return cfb;
  };

  const makeCfbV4 = (streamName) => {
    const cfb = Buffer.alloc(12288);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
    cfb.writeUInt16LE(4, 26);
    cfb.writeUInt16LE(0xfffe, 28);
    cfb.writeUInt16LE(12, 30);
    cfb.writeUInt32LE(1, 44);
    cfb.writeUInt32LE(1, 48);
    cfb.writeUInt32LE(0, 76);
    cfb.writeUInt32LE(0xfffffffd, 4096);
    cfb.writeUInt32LE(0xfffffffe, 4100);
    const entry = 8192;
    const encoded = Buffer.from(`${streamName}\0`, 'utf16le');
    encoded.copy(cfb, entry);
    cfb.writeUInt16LE(encoded.length, entry + 64);
    cfb[entry + 66] = 2;
    return cfb;
  };

  it('rejects binary content disguised as a text file', async () => {
    const { intern, task } = await setup();
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);

    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', binary, 'report.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a real TXT file/i);
    expect(await getBucket().find({ filename: 'report.txt' }).toArray()).toHaveLength(0);
    expect((await Task.findById(task._id)).submission.submittedAt).toBeUndefined();
  });

  it('accepts UTF-8 plain text for text and CSV submissions', async () => {
    const { intern, task } = await setup();
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .field('link', '')
      .attach('file', Buffer.from('name,score\nAda,10\n', 'utf8'), 'report.csv');

    expect(res.status).toBe(200);
    expect((await Task.findById(task._id)).submission.file.originalName).toBe('report.csv');
  });

  it('accepts a legacy Office compound-file signature for a legacy Office extension', async () => {
    const { intern, task } = await setup();
    const legacyOffice = makeCfb('WordDocument');
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', legacyOffice, 'report.doc');

    expect(res.status).toBe(200);
    expect((await Task.findById(task._id)).submission.file.originalName).toBe('report.doc');
  });

  it('accepts valid 4096-byte-sector legacy Office files', async () => {
    const { intern, task } = await setup();
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', makeCfbV4('WordDocument'), 'report.doc');
    expect(res.status).toBe(200);
  });

  it('rejects a valid file signature paired with the wrong extension', async () => {
    const { intern, task } = await setup();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', pdf, 'report.docx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a real DOCX file/i);
    expect(await getBucket().find({ filename: 'report.docx' }).toArray()).toHaveLength(0);
  });

  it('limits the number of multipart fields', async () => {
    const { intern, task } = await setup();
    let request = intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', Buffer.from('plain text'), 'report.txt');
    for (let i = 0; i < 11; i += 1) request = request.field(`extra${i}`, 'x');
    const res = await request;
    expect(res.status).toBe(400);
    expect(await getBucket().find({ filename: 'report.txt' }).toArray()).toHaveLength(0);
  });

  it('does not accept a legacy Office signature under an unrelated extension', async () => {
    const { intern, task } = await setup();
    const legacyOffice = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(504).fill(0)]);
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken)
      .attach('file', legacyOffice, 'report.pdf');

    expect(res.status).toBe(400);
    expect(await getBucket().find({ filename: 'report.pdf' }).toArray()).toHaveLength(0);
  });

  it('rejects a generic CFB container without the matching Office stream name', async () => {
    const { intern, task } = await setup();
    const cfb = makeCfb();
    const res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
      .set('X-CSRF-Token', intern.csrfToken).attach('file', cfb, 'report.doc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a real DOC file/i);
  });

  it('deletes a GridFS file when the task write throws after the upload', async () => {
    const { intern, task } = await setup();
    const updateOne = Task.updateOne;
    const updateSpy = jest.spyOn(Task, 'updateOne').mockRejectedValue(new Error('temporary database failure'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await intern.agent.post(`/api/tasks/${task._id}/submission`)
        .set('X-CSRF-Token', intern.csrfToken)
        .attach('file', Buffer.from('plain text attachment'), 'cleanup.txt');
    } finally {
      updateSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    const orphaned = await getBucket().find({ filename: 'cleanup.txt' }).toArray();
    expect(orphaned).toHaveLength(0);
    expect(Task.updateOne).toBe(updateOne);
  });
});

describe('POST /api/tasks/:id/reopen', () => {
  const reopen = (admin, taskId, body) =>
    admin.agent.post(`/api/tasks/${taskId}/reopen`).set('X-CSRF-Token', admin.csrfToken).send(body);

  it('does not reopen a task if loading the supervisor fails', async () => {
    const { admin, task } = await setup();
    await Task.updateOne({ _id: task._id }, {
      $set: { submission: { link: 'https://github.com/example/repo', submittedAt: new Date() } },
    });
    const originalFindById = User.findById;
    let shouldFail = true;
    const findByIdSpy = jest.spyOn(User, 'findById').mockImplementation(function (id, ...args) {
      if (shouldFail && String(id) === String(admin.user._id)) {
        shouldFail = false;
        return Promise.reject(new Error('database unavailable'));
      }
      return originalFindById.call(this, id, ...args);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await reopen(admin, task._id, { reason: 'Revise the work', dueDate: '2099-06-01' });
    } finally {
      findByIdSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    const saved = await Task.findById(task._id);
    expect(saved.submission.submittedAt).toBeDefined();
    expect(saved.previousSubmissions).toHaveLength(0);
    expect(saved.dueDate.toISOString().slice(0, 10)).toBe('2099-01-01');
  });

  it('sends a submitted task back: the old attempt is kept and the intern can submit again', async () => {
    const { admin, intern, task } = await setup();
    expect((await submit(intern, task._id, 'https://github.com/example/first')).status).toBe(200);

    const res = await reopen(admin, task._id, { reason: 'Add a summary page', dueDate: '2099-06-01' });
    expect(res.status).toBe(200);

    const saved = await Task.findById(task._id);
    expect(saved.submission.submittedAt).toBeUndefined();
    expect(saved.previousSubmissions).toHaveLength(1);
    expect(saved.previousSubmissions[0].link).toBe('https://github.com/example/first');
    expect(saved.previousSubmissions[0].reason).toBe('Add a summary page');
    expect(saved.dueDate.toISOString().slice(0, 10)).toBe('2099-06-01');

    // back on the intern's open list, with the reason on its page
    const live = await intern.agent.get('/api/tasks');
    expect(live.body.map((t) => t._id)).toContain(String(task._id));
    const page = await intern.agent.get(`/tasks/${task._id}`);
    expect(page.text).toContain('Your supervisor asked you to resubmit');
    expect(page.text).toContain('Add a summary page');

    // second attempt works, and can be sent back again
    expect((await submit(intern, task._id, 'https://github.com/example/second')).status).toBe(200);
    expect((await reopen(admin, task._id, { reason: 'One more fix', dueDate: '2099-07-01' })).status).toBe(200);
    expect((await Task.findById(task._id)).previousSubmissions).toHaveLength(2);
  });

  it('refuses when nothing has been submitted, or the details are missing or wrong', async () => {
    const { admin, intern, task } = await setup();
    expect((await reopen(admin, task._id, { reason: 'x', dueDate: '2099-06-01' })).status).toBe(400); // not submitted yet

    await submit(intern, task._id);
    expect((await reopen(admin, task._id, { reason: '  ', dueDate: '2099-06-01' })).status).toBe(400);
    expect((await reopen(admin, task._id, { reason: 'x'.repeat(1001), dueDate: '2099-06-01' })).status).toBe(400);
    expect((await reopen(admin, task._id, { reason: 'x' })).status).toBe(400);
    expect((await reopen(admin, task._id, { reason: 'x', dueDate: 'not a date' })).status).toBe(400);
    const past = await reopen(admin, task._id, { reason: 'x', dueDate: '2000-01-01' });
    expect(past.status).toBe(400);
    expect(past.body.error).toMatch(/past/i);
    expect((await Task.findById(task._id)).submission.submittedAt).toBeDefined(); // still submitted
  });

  it('does not attach feedback after a concurrent reopen wins', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id);
    const submitted = await Task.findById(task._id);
    const updateOne = Task.updateOne;
    Task.updateOne = async function (filter, update, options) {
      if (update.$set?.['submission.feedback']) {
        const snapshot = submitted.toObject().submission;
        await updateOne.call(this,
          { _id: task._id, 'submission.submittedAt': snapshot.submittedAt, __v: submitted.__v },
          {
            $push: { previousSubmissions: { ...snapshot, reopenedAt: new Date(), reason: 'Revise' } },
            $unset: { submission: '' },
            $inc: { __v: 1 },
          },
        );
      }
      return updateOne.call(this, filter, update, options);
    };
    let res;
    try {
      res = await admin.agent.post(`/api/tasks/${task._id}/feedback`)
        .set('X-CSRF-Token', admin.csrfToken).send({ text: 'Looks good.' });
    } finally {
      Task.updateOne = updateOne;
    }

    expect(res.status).toBe(409);
    const saved = await Task.findById(task._id);
    expect(saved.submission.submittedAt).toBeUndefined();
    expect(saved.submission.feedback?.text).toBeUndefined();
    expect(saved.previousSubmissions).toHaveLength(1);
  });

  it('preserves feedback when it wins just before a concurrent reopen', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id);
    const submitted = await Task.findById(task._id);
    const updateOne = Task.updateOne;
    Task.updateOne = async function (filter, update, options) {
      if (update.$push?.previousSubmissions) {
        await updateOne.call(this,
          { _id: task._id, 'submission.submittedAt': submitted.submission.submittedAt, __v: submitted.__v },
          {
            $set: { 'submission.feedback': { text: 'Looks good.', givenAt: new Date() } },
            $inc: { __v: 1 },
          },
        );
      }
      return updateOne.call(this, filter, update, options);
    };
    let res;
    try {
      res = await reopen(admin, task._id, { reason: 'Revise', dueDate: '2099-06-01' });
    } finally {
      Task.updateOne = updateOne;
    }

    expect(res.status).toBe(409);
    const saved = await Task.findById(task._id);
    expect(saved.submission.submittedAt).toBeDefined();
    expect(saved.submission.feedback.text).toBe('Looks good.');
    expect(saved.previousSubmissions).toHaveLength(0);
  });

  it('is for the supervisor who owns the task only', async () => {
    const { intern, task } = await setup();
    await submit(intern, task._id);
    const asIntern = await intern.agent.post(`/api/tasks/${task._id}/reopen`).set('X-CSRF-Token', intern.csrfToken).send({ reason: 'x', dueDate: '2099-06-01' });
    expect(asIntern.status).toBe(403);

    const other = await makeAdmin(app, { name: 'Other Admin', email: 'other-admin@test.com' });
    const asOther = await other.agent.post(`/api/tasks/${task._id}/reopen`).set('X-CSRF-Token', other.csrfToken).send({ reason: 'x', dueDate: '2099-06-01' });
    expect(asOther.status).toBe(404);
  });

  it('refuses when the internship has ended', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id);
    await User.updateOne({ _id: intern.user._id }, { $set: { active: false } });
    const res = await reopen(admin, task._id, { reason: 'x', dueDate: '2099-06-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ended/i);
  });

  it('a task with an earlier attempt can no longer be deleted', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id);
    await reopen(admin, task._id, { reason: 'x', dueDate: '2099-06-01' });
    const res = await admin.agent.delete(`/api/tasks/${task._id}`).set('X-CSRF-Token', admin.csrfToken);
    expect(res.status).toBe(403);
    expect(await Task.findById(task._id)).not.toBeNull();
  });

  it('shows earlier attempts on the page and never leaks them in the JSON lists', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id, 'https://github.com/example/first');
    await reopen(admin, task._id, { reason: 'Add a summary page', dueDate: '2099-06-01' });

    const page = await admin.agent.get(`/tasks/${task._id}`);
    expect(page.text).toContain('Earlier attempts');
    expect(page.text).toContain('https://github.com/example/first');
    expect(page.text).toContain('Waiting for a new version');

    const live = await admin.agent.get('/api/tasks');
    const archived = await admin.agent.get('/api/tasks/archived');
    expect(live.body[0]).not.toHaveProperty('previousSubmissions');
    expect(archived.body[0]).not.toHaveProperty('previousSubmissions');
  });

  it('answers 404 for an earlier-attempt file that does not exist', async () => {
    const { admin, intern, task } = await setup();
    await submit(intern, task._id); // link only, so no file to download
    await reopen(admin, task._id, { reason: 'x', dueDate: '2099-06-01' });
    expect((await admin.agent.get(`/api/tasks/${task._id}/earlier/0/file`)).status).toBe(404);
    expect((await admin.agent.get(`/api/tasks/${task._id}/earlier/9/file`)).status).toBe(404);
    expect((await admin.agent.get(`/api/tasks/${task._id}/earlier/abc/file`)).status).toBe(404);
  });
});
