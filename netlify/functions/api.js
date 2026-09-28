import express from 'express';
import serverless from 'serverless-http';
import { google } from 'googleapis';

const app = express();

const CONFIG = {
  CONTACTS_SHEET_NAME: 'Контакти',
  BLACKLIST_SHEET_NAME: 'Чорний список',
  FIRST_DATA_ROW: 2,
};

/**
 * Google authorization.
 *
 * GOOGLE_SERVICE_ACCOUNT_EMAIL
 * GOOGLE_PRIVATE_KEY
 *
 * зберігаються в Environment Variables на Netlify.
 */
function getGoogleAuth() {
  const clientEmail =
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

  let privateKey =
    process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail) {
    throw new Error(
      'Не задано GOOGLE_SERVICE_ACCOUNT_EMAIL'
    );
  }

  if (!privateKey) {
    throw new Error(
      'Не задано GOOGLE_PRIVATE_KEY'
    );
  }

  // Якщо ключ записаний з \n
  privateKey = privateKey.replace(/\\n/g, '\n').trim();

  if (
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----') ||
    !privateKey.endsWith('-----END PRIVATE KEY-----')
  ) {
    throw new Error(
      'GOOGLE_PRIVATE_KEY має неправильний формат'
    );
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
}

/**
 * GET
 *
 * /api/contacts
 *
 * ?spreadsheetId=...
 * &address=Новополонська 14,Староміська 60
 */
app.get('/api/contacts', async (req, res) => {
  try {
    const spreadsheetId = String(
      req.query.spreadsheetId || ''
    ).trim();

    const addressParameter = String(
      req.query.address || ''
    ).trim();

    if (!spreadsheetId) {
      return res.status(400).json({
        success: false,
        error: 'Не передано параметр spreadsheetId',
      });
    }

    if (!addressParameter) {
      return res.status(400).json({
        success: false,
        error: 'Не передано параметр address',
        example:
          '?spreadsheetId=ID&address=Новополонська 14,Староміська 60',
      });
    }

    const requestedAddresses = addressParameter
      .split(',')
      .map(address => address.trim())
      .filter(Boolean);

    if (!requestedAddresses.length) {
      return res.status(400).json({
        success: false,
        error: 'Список адрес порожній',
      });
    }

    /*
     * Читаємо Google Spreadsheet.
     */
    const auth = getGoogleAuth();

    const sheets = google.sheets({
      version: 'v4',
      auth,
    });

    /*
     * Одним API-запитом отримуємо обидва аркуші.
     *
     * Контакти:
     * A — телефон
     * B — адреса
     *
     * Чорний список:
     * A — адреса
     * B — причина
     */
    const response =
      await sheets.spreadsheets.values.batchGet({
        spreadsheetId,

        ranges: [
          `'${CONFIG.CONTACTS_SHEET_NAME}'!A${CONFIG.FIRST_DATA_ROW}:B`,
          `'${CONFIG.BLACKLIST_SHEET_NAME}'!A${CONFIG.FIRST_DATA_ROW}:B`,
        ],

        valueRenderOption: 'FORMATTED_VALUE',
      });

    const valueRanges =
      response.data.valueRanges || [];

    const contactsRows =
      valueRanges[0]?.values || [];

    const blacklistRows =
      valueRanges[1]?.values || [];

    const contacts = readContacts(contactsRows);
    const blacklist = readBlacklist(blacklistRows);

    const results = requestedAddresses.map(
      requestedAddress =>
        createAddressResult(
          requestedAddress,
          contacts,
          blacklist
        )
    );

    return res.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error(error);

    /*
     * Google повертає 403, якщо service account
     * не має доступу до таблиці.
     */
    if (
      error?.code === 403 ||
      error?.response?.status === 403
    ) {
      return res.status(403).json({
        success: false,
        error:
          'Немає доступу до Google Таблиці. ' +
          'Надайте доступ service account.',
      });
    }

    /*
     * 404 — неправильний spreadsheetId
     * або таблиця недоступна.
     */
    if (
      error?.code === 404 ||
      error?.response?.status === 404
    ) {
      return res.status(404).json({
        success: false,
        error:
          'Google Таблицю не знайдено. Перевірте spreadsheetId.',
      });
    }

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        'Внутрішня помилка сервера',
    });
  }
});


/*
|--------------------------------------------------------------------------
| Contacts
|--------------------------------------------------------------------------
*/

function readContacts(rows) {
  return rows
    .map(row => {
      const phone = String(
        row[0] || ''
      ).trim();

      const address = String(
        row[1] || ''
      ).trim();

      return {
        phone,
        address,
        normalizedAddress:
          normalizeAddress(address),
      };
    })
    .filter(contact => contact.address);
}


/*
|--------------------------------------------------------------------------
| Blacklist
|--------------------------------------------------------------------------
*/

function readBlacklist(rows) {
  return rows
    .map(row => {
      const address = String(
        row[0] || ''
      ).trim();

      const reason = String(
        row[1] || ''
      ).trim();

      return {
        address,
        reason,
        normalizedAddress:
          normalizeAddress(address),
      };
    })
    .filter(item => item.address);
}


/*
|--------------------------------------------------------------------------
| Result
|--------------------------------------------------------------------------
*/

function createAddressResult(
  requestedAddress,
  contacts,
  blacklist
) {
  const normalizedRequest =
    normalizeAddress(requestedAddress);

  const contactMatches =
    findBestMatches(
      normalizedRequest,
      contacts
    );

  const blacklistMatches =
    findBestMatches(
      normalizedRequest,
      blacklist
    );

  const phones = [
    ...new Set(
      contactMatches
        .map(contact => contact.phone)
        .filter(Boolean)
    ),
  ];

  const blacklistReasons = [
    ...new Set(
      blacklistMatches
        .map(item => item.reason)
        .filter(Boolean)
    ),
  ];

  return {
    address: requestedAddress,

    found:
      contactMatches.length > 0,

    phones,

    matches:
      contactMatches.map(contact => ({
        address: contact.address,
        phone: contact.phone || null,
      })),

    blacklisted:
      blacklistMatches.length > 0,

    blacklistReason:
      blacklistReasons.length
        ? blacklistReasons.join('; ')
        : null,

    blacklistMatches:
      blacklistMatches.map(item => ({
        address: item.address,
        reason: item.reason || null,
      })),
  };
}


/*
|--------------------------------------------------------------------------
| Search
|--------------------------------------------------------------------------
*/

function findBestMatches(
  normalizedRequest,
  items
) {
  const matches = items
    .map(item => ({
      ...item,

      matchScore:
        getMatchScore(
          normalizedRequest,
          item.normalizedAddress
        ),
    }))
    .filter(
      item => item.matchScore > 0
    )
    .sort(
      (a, b) =>
        b.matchScore -
        a.matchScore
    );

  if (!matches.length) {
    return [];
  }

  const bestScore =
    matches[0].matchScore;

  return matches.filter(
    item =>
      item.matchScore === bestScore
  );
}


/*
|--------------------------------------------------------------------------
| Address normalization
|--------------------------------------------------------------------------
*/

function normalizeAddress(value) {
  const ignoredWords = new Set([
    'вул',
    'вулиця',
    'пров',
    'провулок',
    'просп',
    'проспект',
    'пл',
    'площа',
    'бул',
    'бульвар',
  ]);

  return String(value || '')
    .toLocaleLowerCase('uk-UA')
    .replace(/[’'`ʼ]/g, '')
    .replace(/[.,;:()[\]{}"«»]/g, ' ')
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(
      word =>
        word &&
        !ignoredWords.has(word)
    )
    .join(' ');
}


/*
|--------------------------------------------------------------------------
| Match score
|--------------------------------------------------------------------------
*/

function getMatchScore(
  requestedAddress,
  storedAddress
) {
  if (
    !requestedAddress ||
    !storedAddress
  ) {
    return 0;
  }

  /*
   * Повний збіг
   */
  if (
    requestedAddress ===
    storedAddress
  ) {
    return 3;
  }

  const requestedWords =
    requestedAddress.split(' ');

  const storedWords =
    storedAddress.split(' ');

  const requestedWordSet =
    new Set(requestedWords);

  const storedWordSet =
    new Set(storedWords);

  /*
   * Усі слова запиту є
   * в адресі таблиці.
   */
  if (
    requestedWords.every(
      word =>
        storedWordSet.has(word)
    )
  ) {
    return 2;
  }

  /*
   * Адреса таблиці є
   * частиною запиту.
   */
  if (
    storedWords.every(
      word =>
        requestedWordSet.has(word)
    )
  ) {
    return 1;
  }

  return 0;
}


/*
|--------------------------------------------------------------------------
| Health check
|--------------------------------------------------------------------------
*/

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API працює',
  });
});


export const handler =
  serverless(app);