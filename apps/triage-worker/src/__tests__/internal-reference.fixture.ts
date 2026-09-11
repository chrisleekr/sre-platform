// A document reference a model might cite in its own output. publicModelText must return it
// untouched, so the exact token is arbitrary; only its shape matters. Shared by the suites that
// need a stand-in reference so they all assert against one string.
export const INTERNAL_REFERENCE = 'DEC-0015';
