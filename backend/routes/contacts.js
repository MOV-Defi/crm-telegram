const express = require('express');
const { getClient } = require('../telegram');
const { Api } = require('telegram');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    // Отримуємо список контактів
    const result = await client.invoke(new Api.contacts.GetContacts({
        hash: 0n, // Використовуємо 0n для BigInt
    }));
    
    // Форматування для фронтенду
    const formattedContacts = result.users.map(u => ({
        id: u.id ? u.id.toString() : null,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        username: u.username || '',
        phone: u.phone || '',
        isMutualContact: u.mutualContact,
    })).filter(u => u.id !== null);

    res.json(formattedContacts);
  } catch (error) {
    console.error('Помилка отримання контактів:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const contactId = req.params.id;
    if (!contactId) {
      return res.status(400).json({ error: 'Відсутній ID контакту' });
    }

    const inputEntity = await client.getInputEntity(contactId);
    await client.invoke(new Api.contacts.DeleteContacts({
      id: [inputEntity]
    }));

    res.json({ success: true });
  } catch (error) {
    console.error('Помилка видалення контакту:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
