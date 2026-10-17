const readline = require("node:readline");

function readSecret(input = process.stdin, output = process.stdout) {
  output.write("Password: ");
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output, terminal: false });
    return new Promise((resolve) => rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    }));
  }

  return new Promise((resolve, reject) => {
    let secret = "";
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          input.setRawMode(false);
          input.off("data", onData);
          output.write("\n");
          reject(new Error("Password entry cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          input.setRawMode(false);
          input.off("data", onData);
          output.write("\n");
          resolve(secret);
          return;
        }
        if (char === "\u007f" || char === "\b") secret = secret.slice(0, -1);
        else if (char >= " ") secret += char;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}

module.exports = readSecret;
