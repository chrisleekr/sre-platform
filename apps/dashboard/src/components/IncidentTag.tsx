export interface IncidentTagLinkRule {
  prefix: string;
  urlTemplate: string;
}

function tagHref(tag: string, rules: readonly IncidentTagLinkRule[]): string | null {
  const separator = tag.indexOf(':');
  if (separator < 1) return null;
  const prefix = tag.slice(0, separator);
  const value = tag.slice(separator + 1);
  const rule = rules.find((candidate) => candidate.prefix === prefix);
  if (!rule || !rule.urlTemplate.includes('{value}')) return null;
  const href = rule.urlTemplate.replaceAll('{value}', encodeURIComponent(value));
  try {
    const url = new URL(href);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Renders a free-form tag with an optional validated HTTPS link. */
export function IncidentTag(props: { tag: string; linkRules: readonly IncidentTagLinkRule[] }) {
  const href = tagHref(props.tag, props.linkRules);
  return href ? <a href={href}>{props.tag}</a> : <span>{props.tag}</span>;
}
