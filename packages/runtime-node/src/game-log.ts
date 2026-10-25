/** Convert Mojang's XML console layout to readable lines without treating it as HTML. */
export class GameLogFormatter {
  private prefix = '';
  private cdata = false;
  format(line: string): string | undefined {
    const trimmed = line.trim();
    if (/^<log4j:Event\s/.test(trimmed)) {
      const level = trimmed.match(/level="([A-Z]+)"/)?.[1] ?? 'INFO';
      const thread = trimmed.match(/thread="([^"]+)"/)?.[1];
      this.prefix = `[${level}${thread ? `/${thread}` : ''}] `;
      return undefined;
    }
    if (/^<\/?log4j:(?:Event|EventSet)(?:\s|>|\/)/.test(trimmed) || /^<\?xml/.test(trimmed)) return undefined;
    const start = line.indexOf('<![CDATA[');
    if (start >= 0) {
      const content = line.slice(start + 9);
      const end = content.indexOf(']]>');
      this.cdata = end < 0;
      return this.prefix + (end < 0 ? content : content.slice(0, end));
    }
    if (this.cdata) {
      const end = line.indexOf(']]>');
      if (end >= 0) {
        this.cdata = false;
        return line.slice(0, end) || undefined;
      }
      return line;
    }
    if (/^<\/?log4j:(?:Message|Throwable)/.test(trimmed)) {
      const content = trimmed
        .replace(/<[^>]*>/g, '')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&amp;', '&');
      return content ? this.prefix + content : undefined;
    }
    return line;
  }
}
