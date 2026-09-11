/** Structured name attributes accepted for a SCIM User. */
export interface DirectoryName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
}

/** Structured email attributes accepted for a SCIM User. */
export interface DirectoryEmail {
  value: string;
  type?: string;
  primary?: boolean;
}
