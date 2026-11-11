// These are the active enterprise conventional-commit and squash-message rules.
// Unicode mode counts code points, matching GitHub's regex character budget.
export const RULES = [
  /^(?:Merge [^\r\n]+|[a-z]+(?:\([^)\r\n]+\))?!?: [^\r\n]{1,72}|Revert "[^"\r\n]{1,72}")(?:\r?\n|$)/u,
  /^(?:[a-z]+(?:\([^)\r\n]+\))?!?: [^\r\n]{1,72}|Revert "[^"\r\n]{1,72}")(?:\r?\n\r?\n[\s\S]+)?\r?\n?$/u,
];

export function validateCommitMessage(message) {
  if (typeof message !== 'string' || !message.isWellFormed() || Buffer.byteLength(message, 'utf8') > 65536) {
    throw new Error('A commit message must be well-formed text within 64 KiB.');
  }
  return RULES.every(rule => rule.test(message));
}

export function validateTitle(title, number) {
  if (typeof title !== 'string' || !title.isWellFormed() || /[\r\n]/u.test(title) || title.length > 4096) {
    throw new Error('The PR title must be one well-formed line.');
  }
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive PR number is required.');
  const suffix = ` (#${number})`;
  const squashTitle = title + suffix;
  const match = /^([a-z]+(?:\([^)\r\n]+\))?!?: )([^\r\n]*)$/u.exec(title);
  const maximumSubject = 72 - [...suffix].length;
  const subjectLength = match ? [...match[2]].length : undefined;
  const valid = RULES.every(rule => rule.test(title) && rule.test(squashTitle));
  let explanation;
  if (valid) explanation = 'The PR title and GitHub squash suffix satisfy both enterprise message rules.';
  else if (!match) explanation = 'Use a conventional title such as "feat: add account settings" or "fix(api): reject invalid tokens". Reverts can use "revert: ..." so the PR suffix stays inside the conventional subject.';
  else if (subjectLength > maximumSubject) explanation = `The subject after "${match[1].trimEnd()}" has ${subjectLength} characters. PR #${number} leaves ${maximumSubject} characters before GitHub appends "${suffix.trimStart()}"; the final subject must fit 72.`;
  else explanation = 'Add a nonempty subject after the conventional type and colon.';
  return { valid, squashTitle, maximumSubject, subjectLength, explanation };
}

export function annotationData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function summary(result) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '&#96;');
  return `### PR message policy: ${result.valid ? 'passed' : 'failed'}\n\n${escape(result.explanation)}\n\nPredicted default squash title:\n\n<pre>${escape(result.squashTitle)}</pre>\n\nThe shared action checks the current PR title, its dynamic PR-number suffix and PR commit messages. GitHub still validates any manually edited merge message.\n`;
}
