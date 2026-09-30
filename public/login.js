const form = document.getElementById('login');
const error = document.getElementById('error');

fetch('/api/login-info').then((r) => r.json()).then((info) => {
  if (!info.hasUsers) {
    document.getElementById('hint').textContent =
      'Er zijn nog geen gebruikers. Stel ADMIN_EMAIL en ADMIN_PASSWORD in op de server, of gebruik "npm run gebruiker -- toevoegen".';
  }
  if (info.demoLogin) {
    const demo = document.getElementById('demo');
    demo.hidden = false;
    demo.innerHTML = `Demo-modus – log in met <b>${info.demoLogin.email}</b> / <b>${info.demoLogin.password}</b>
      (of als medewerker: magazijn@tochtstripdeur.nl, alleen bekijken: boekhouding@tochtstripdeur.nl – zelfde wachtwoord).`;
    form.email.value = info.demoLogin.email;
    form.password.value = info.demoLogin.password;
  }
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Inloggen mislukt');
    location.href = '/';
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    button.disabled = false;
  }
});
