// Asks for a password in the terminal. Shows a * for every character typed (so you can see
// that typing is working and roughly how long it is) without ever showing the password itself.
// Backspace works. Ctrl+C cancels. When input is piped in (not a real keyboard), it reads one line per call.
let pipedLines = null;

function readPiped() {
  return new Promise((resolve) => {
    if (pipedLines) return resolve();
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { pipedLines = buf.split(/\r?\n/); resolve(); });
  });
}

function askPassword(label = 'Password: ') {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return readPiped().then(() => pipedLines.shift() ?? '');

  return new Promise((resolve) => {
    let chars = [];
    let escapeState = null;
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(chars.join(''));
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); } // Ctrl+C
        if (escapeState === 'escape') {
          if (ch === '[') { escapeState = 'csi'; continue; }
          if (ch === 'O') { escapeState = 'ss3'; continue; }
          escapeState = null;
        } else if (escapeState === 'csi' || escapeState === 'ss3') {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) escapeState = null;
          continue;
        }
        if (ch === '\u001b') { escapeState = 'escape'; continue; } // buffer split terminal escape sequences
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') {
          if (chars.length) { chars.pop(); stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue; // other control characters
        chars.push(ch);
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

module.exports = askPassword;
