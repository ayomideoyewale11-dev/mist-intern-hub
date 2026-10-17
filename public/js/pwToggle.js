// Show/hide buttons next to password fields.
// Hub pages: .hub-pw > input + .hub-eye. Login and reset pages: .lg-pw > input + .lg-eye.
document.querySelectorAll('.hub-pw, .lg-pw').forEach((wrap) => {
  const input = wrap.querySelector('input');
  const btn = wrap.querySelector('.hub-eye, .lg-eye');
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});
