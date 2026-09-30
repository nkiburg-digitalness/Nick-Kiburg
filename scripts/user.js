/**
 * Manage dashboard users from the command line (handy for the first account or
 * when the only beheerder forgot the password).
 *
 *   npm run gebruiker -- lijst
 *   npm run gebruiker -- toevoegen <e-mail> "<naam>" [beheerder|medewerker|kijker]
 *   npm run gebruiker -- wachtwoord <e-mail>
 *
 * New and reset passwords are generated and printed once.
 */
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { generatePassword, ROLES } from '../src/auth.js';

const [command, email, name, role = 'medewerker'] = process.argv.slice(2);
const app = createApp(config);
const { auth } = app;

try {
  if (command === 'lijst') {
    const users = auth.listUsers();
    if (!users.length) console.log('Nog geen gebruikers.');
    for (const u of users) {
      console.log(`${u.email.padEnd(34)} ${u.name.padEnd(24)} ${ROLES[u.role].label}${u.disabled ? ' (geblokkeerd)' : ''}`);
    }
  } else if (command === 'toevoegen' && email && name) {
    const password = generatePassword();
    const user = await auth.createUser({ email, name, role, password });
    console.log(`Gebruiker ${user.name} (${ROLES[user.role].label}) aangemaakt.`);
    console.log(`Tijdelijk wachtwoord: ${password}`);
    console.log('Geef dit veilig door; het kan na inloggen worden gewijzigd via "Mijn account".');
  } else if (command === 'wachtwoord' && email) {
    const user = auth.listUsers().find((u) => u.email === email.trim().toLowerCase());
    if (!user) throw new Error(`Geen gebruiker met e-mailadres ${email}`);
    const password = generatePassword();
    await auth.setPassword(user.id, password);
    console.log(`Nieuw wachtwoord voor ${user.name}: ${password}`);
  } else {
    console.log('Gebruik:');
    console.log('  npm run gebruiker -- lijst');
    console.log('  npm run gebruiker -- toevoegen <e-mail> "<naam>" [beheerder|medewerker|kijker]');
    console.log('  npm run gebruiker -- wachtwoord <e-mail>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  app.stop();
}
