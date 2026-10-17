const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/task.js'), 'utf8');

describe('task edit client', () => {
  it('submits the named title input instead of the form title property', async () => {
    let submit;
    let apiCall;
    const controls = {
      title: { value: 'Updated title' },
      description: { value: 'Updated description' },
      dueDate: { value: '2099-06-01' },
    };
    const form = {
      title: 'A form title attribute',
      dataset: { taskId: 'task-123' },
      elements: { namedItem: (name) => controls[name] },
      addEventListener: (name, handler) => { if (name === 'submit') submit = handler; },
    };
    const context = {
      document: { getElementById: (id) => id === 'edit-form' ? form : null },
      window: { location: { search: '', reload() {} } },
      URLSearchParams,
      api: async (...args) => { apiCall = args; return {}; },
      uiFlash() {},
      uiToast() {},
    };

    vm.runInNewContext(source, context);
    await submit({ preventDefault() {}, target: form });

    expect(apiCall[0]).toBe('/api/tasks/task-123');
    expect(JSON.parse(apiCall[1].body)).toEqual({
      title: 'Updated title',
      description: 'Updated description',
      dueDate: '2099-06-01',
    });
  });
});
