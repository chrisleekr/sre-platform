export interface OidcProvider {
  providerId: string;
  issuer: string;
  authorizationEndpoint: string;
  clientId: string;
  scopes: string[];
  authorizationAudience?: string | null;
}
