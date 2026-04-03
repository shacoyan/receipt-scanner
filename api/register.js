export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const { date, amount, store, category, memo } = request.body;

  const accessToken = process.env.FREEE_ACCESS_TOKEN || 'dummy_token';

  try {
    const res = await fetch('https://api.freee.co.jp/api/1/deals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        company_id: Number(process.env.FREEE_COMPANY_ID),
        issue_date: date,
        type: 'expense',
        details: [
          {
            account_item_name: category,
            amount,
            description: `${memo} ${store}`,
            tax_code: 0,
          },
        ],
      }),
    });

    if (res.ok) {
      return response.status(200).json({ success: true });
    } else {
      return response.status(500).json({ error: 'Failed to register' });
    }
  } catch {
    return response.status(500).json({ error: 'Failed to register' });
  }
}
