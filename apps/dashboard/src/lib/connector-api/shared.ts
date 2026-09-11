export function connectorMutationUrl(apiBaseUrl: string, type: string, id?: string): string {
  return `${apiBaseUrl}/connectors/${type}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
