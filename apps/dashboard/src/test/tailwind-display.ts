// jsdom never loads the Tailwind stylesheet, and from jsdom 27 getComputedStyle reports the user-agent
// `display: inline` for a span or strong styled `block`. Accessible names join inline children with no
// separator, so `getByRole(..., { name })` saw "Project hooksEvery GitLab tier" where a browser reads
// "Project hooks Every GitLab tier". Declare the display utilities the dashboard uses so computed
// names match the browser. Responsive variants and `hidden` are left out: jsdom has no viewport, and
// hiding elements here would change which elements tests can query.
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent =
    '.block{display:block}.flex{display:flex}.grid{display:grid}' +
    '.inline-block{display:inline-block}.inline-flex{display:inline-flex}.inline-grid{display:inline-grid}';
  document.head.append(style);
}
