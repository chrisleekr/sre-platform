import type { directoryAccounts } from '@sre/db';
import {
  SCIM_LIST_SCHEMA,
  SCIM_RESOURCE_TYPE_SCHEMA,
  SCIM_SCHEMA_SCHEMA,
  SCIM_SERVICE_PROVIDER_SCHEMA,
  SCIM_USER_SCHEMA,
} from './constants';

type Account = typeof directoryAccounts.$inferSelect;

/** Renders one current database row as an RFC 7643 core User resource. */
export function scimUser(account: Account, baseUrl: string) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: account.id,
    ...(account.externalId ? { externalId: account.externalId } : {}),
    userName: account.userName,
    active: account.active,
    ...(Object.keys(account.name).length ? { name: account.name } : {}),
    ...(account.emails.length ? { emails: account.emails } : {}),
    meta: {
      resourceType: 'User',
      created: account.createdAt.toISOString(),
      lastModified: account.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${account.id}`,
    },
  };
}

/** Renders one bounded SCIM ListResponse. */
export function scimList(resources: unknown[], totalResults: number, startIndex: number) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export const serviceProviderConfig = {
  schemas: [SCIM_SERVICE_PROVIDER_SCHEMA],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'Bearer token',
      description: 'Provider-scoped bearer token configured by a platform administrator.',
      specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
      primary: true,
    },
  ],
};

export const userResourceType = {
  schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
  id: 'User',
  name: 'User',
  endpoint: '/Users',
  schema: SCIM_USER_SCHEMA,
};

export const userSchema = {
  schemas: [SCIM_SCHEMA_SCHEMA],
  id: SCIM_USER_SCHEMA,
  name: 'User',
  description: 'SRE Platform directory account',
  attributes: [
    {
      name: 'userName',
      type: 'string',
      multiValued: false,
      required: true,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    },
    {
      name: 'externalId',
      type: 'string',
      multiValued: false,
      required: false,
      caseExact: true,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    },
    {
      name: 'active',
      type: 'boolean',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
    },
    {
      name: 'name',
      type: 'complex',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      subAttributes: [
        'formatted',
        'familyName',
        'givenName',
        'middleName',
        'honorificPrefix',
        'honorificSuffix',
      ].map((name) => ({
        name,
        type: 'string',
        multiValued: false,
        required: false,
        mutability: 'readWrite',
        returned: 'default',
      })),
    },
    {
      name: 'emails',
      type: 'complex',
      multiValued: true,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      subAttributes: [
        {
          name: 'value',
          type: 'string',
          multiValued: false,
          required: true,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'type',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'primary',
          type: 'boolean',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
      ],
    },
  ],
};
