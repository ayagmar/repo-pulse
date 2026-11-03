/**
 * A short, readable excerpt of a Markdown body for an embed's description. Discord does
 * not render tables, HTML or images, and an unclosed code fence swallows whatever is
 * appended after the excerpt, so all of those are removed or kept whole, and the cut
 * falls on a paragraph, sentence or word boundary, never inside a fence.
 */

interface ExcerptOptions {
  limit: number;
  /** Heading lines containing one of these (case-insensitive) are dropped. */
  dropHeadingsContaining?: readonly string[];
  /** Sections whose heading contains one of these (case-insensitive) are dropped whole. */
  dropSectionsContaining?: readonly string[];
}

const ELLIPSIS = '…';
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$|^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const SENTENCE_END = /[.!?](?=\s)/g;

/** A block of text: a paragraph, or a whole fenced code block. */
interface Block {
  text: string;
  fenced: boolean;
}

function stripInline(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/** Splits the body into blocks, dropping what Discord would show as noise. */
function toBlocks(body: string, options: ExcerptOptions): Block[] {
  const { dropHeadingsContaining = [], dropSectionsContaining = [] } = options;
  const withoutHidden = body
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details[\s>][\s\S]*?<\/details>/gi, '');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  /** The level of the heading of a section being dropped, until a heading as high ends it. */
  let skippedLevel: number | null = null;

  const endParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    if (text !== '') {
      blocks.push({ text, fenced: false });
    }
    paragraph = [];
  };

  for (const line of withoutHidden.split('\n')) {
    if (fence !== null) {
      fence.push(line);
      if (FENCE.test(line)) {
        if (skippedLevel === null) {
          blocks.push({ text: fence.join('\n'), fenced: true });
        }
        fence = null;
      }
      continue;
    }
    if (FENCE.test(line)) {
      endParagraph();
      fence = [line.trim()];
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      endParagraph();
      const level = line.trim().indexOf(' ');
      const title = (heading[1] ?? '').toLowerCase();
      if (skippedLevel !== null && level <= skippedLevel) {
        skippedLevel = null;
      }
      if (
        skippedLevel === null &&
        dropSectionsContaining.some((needle) => title.includes(needle))
      ) {
        skippedLevel = level;
      }
      if (skippedLevel !== null) {
        continue;
      }
      if (dropHeadingsContaining.some((needle) => title.includes(needle))) {
        continue;
      }
      // A heading renders large in an embed; the words carry the meaning.
      const plain = stripInline(heading[1] ?? '').trim();
      if (plain !== '') {
        blocks.push({ text: plain, fenced: false });
      }
      continue;
    }
    if (skippedLevel !== null || TABLE_ROW.test(line) || CHECKBOX.test(line)) {
      continue;
    }
    const plain = stripInline(line).trimEnd();
    if (plain.trim() === '') {
      endParagraph();
    } else {
      paragraph.push(plain);
    }
  }
  endParagraph();
  // A fence still open here never closed, and would swallow what follows it: it is dropped.
  return blocks;
}

/** `text` cut to fit `limit` characters with an ellipsis, on a sentence or word boundary. */
function cutText(text: string, limit: number): string {
  const room = limit - ELLIPSIS.length;
  const head = text.slice(0, room);
  let cut = -1;
  for (const match of head.matchAll(SENTENCE_END)) {
    cut = match.index + 1;
  }
  if (cut < room / 3) {
    cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
  }
  let kept = (cut > 0 ? head.slice(0, cut) : head).trimEnd();
  // An inline code span cut in half would turn the rest of the message into code.
  if ((kept.match(/`/g)?.length ?? 0) % 2 === 1) {
    kept = kept.slice(0, kept.lastIndexOf('`')).trimEnd();
  }
  return `${kept}${ELLIPSIS}`;
}

export function excerpt(body: string | null, options: ExcerptOptions): string | null {
  if (body === null) {
    return null;
  }
  const blocks = toBlocks(body, options);
  let text = '';
  let truncated = false;
  for (const block of blocks) {
    const next = text === '' ? block.text : `${text}\n\n${block.text}`;
    if (next.length <= options.limit) {
      text = next;
      continue;
    }
    truncated = true;
    if (!block.fenced && text === '') {
      text = cutText(block.text, options.limit);
      truncated = false;
    } else if (!block.fenced && options.limit - text.length > 60) {
      text = `${text}\n\n${cutText(block.text, options.limit - text.length - 2)}`;
      truncated = false;
    }
    break;
  }
  if (truncated && text !== '') {
    text = text.length < options.limit ? `${text}${ELLIPSIS}` : cutText(text, options.limit);
  }
  return text === '' ? null : text;
}
