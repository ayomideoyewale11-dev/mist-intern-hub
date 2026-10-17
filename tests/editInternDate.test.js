const fs = require("fs");
const path = require("path");
const vm = require("vm");

function dateKey(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadEndDateChangeHandler() {
  const listeners = {};
  const endInput = {
    value: "",
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };
  const activeCheckbox = { checked: false };
  const editForm = {
    dataset: { terminated: "false" },
    addEventListener: () => {},
  };
  const elements = {
    "edit-intern-form": editForm,
    editInternEnd: endInput,
    editInternActive: activeCheckbox,
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => ({ content: dateKey() }),
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../public/js/editIntern.js"),
    "utf8",
  );

  vm.runInNewContext(source, { document, Date });
  return { endInput, activeCheckbox, handler: listeners.change };
}

describe("edit intern end-date change handler", () => {
  it("does not auto-activate an intern when the end date is in the past", () => {
    const { endInput, activeCheckbox, handler } = loadEndDateChangeHandler();
    endInput.value = dateKey(-1);

    handler({ target: endInput });

    expect(activeCheckbox.checked).toBe(false);
  });

  it("auto-activates an intern when the end date is today", () => {
    const { endInput, activeCheckbox, handler } = loadEndDateChangeHandler();
    endInput.value = dateKey();

    handler({ target: endInput });

    expect(activeCheckbox.checked).toBe(true);
  });

  it("auto-activates an intern when the end date is in the future", () => {
    const { endInput, activeCheckbox, handler } = loadEndDateChangeHandler();
    endInput.value = dateKey(1);

    handler({ target: endInput });

    expect(activeCheckbox.checked).toBe(true);
  });
});
