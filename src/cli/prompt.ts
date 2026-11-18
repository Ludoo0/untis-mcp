/**
 * Minimal terminal input for CLI tools (compatibility check, dev scripts).
 * The hidden variant echoes "*" instead of the typed characters (for passwords).
 */

/** Reads a line from the terminal; with hidden=true it echoes * instead of the text. */
function readInput(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      reject(new Error("No interactive terminal – run this directly in a terminal (or set the UNTIS_* variables)."));
      return;
    }
    let input = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\u007f" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += ch;
          process.stdout.write(hidden ? "*" : ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

export const readLine = (q: string) => readInput(q, false).then((s) => s.trim());
export const readHidden = (q: string) => readInput(q, true);
