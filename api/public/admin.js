const loginPanel = document.getElementById('loginPanel');
const ledgerPanel = document.getElementById('ledgerPanel');
const loginForm = document.getElementById('loginForm');
const loginNotice = document.getElementById('loginNotice');
const ledgerNotice = document.getElementById('ledgerNotice');
const monthFilter = document.getElementById('monthFilter');
const transactionRows = document.getElementById('transactionRows');
const exportButton = document.getElementById('exportButton');
const logoutButton = document.getElementById('logoutButton');

function currentKenyaMonth() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  return `${year}-${month}`;
}

function money(value) {
  return new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(value || 0);
}

function addCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value || '—';
  row.append(cell);
  return cell;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const result = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : {};
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

async function loadTransactions() {
  ledgerNotice.textContent = 'Loading transactions…';
  const result = await request(`/api/admin/transactions?month=${encodeURIComponent(monthFilter.value)}`);
  document.getElementById('paidCount').textContent = money(result.summary.paidCount);
  document.getElementById('paidTotal').textContent = money(result.summary.paidTotal);
  document.getElementById('requestCount').textContent = money(result.summary.count);
  transactionRows.replaceChildren();

  result.transactions.forEach(transaction => {
    const row = document.createElement('tr');
    addCell(row, new Date(transaction.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }));
    addCell(row, transaction.name);
    addCell(row, `${transaction.phone}\nM-Pesa: ${transaction.payerPhone}`);
    addCell(row, transaction.services.join(', '));
    addCell(row, `KSh ${money(transaction.amount)}`);
    const statusCell = addCell(row, '');
    const badge = document.createElement('span');
    badge.className = `status ${transaction.status}`;
    badge.textContent = transaction.status;
    statusCell.append(badge);
    addCell(row, transaction.receipt);
    const actionCell = document.createElement('td');
    if (transaction.canReverify) {
      const verifyButton = document.createElement('button');
      verifyButton.type = 'button';
      verifyButton.className = 'secondary';
      verifyButton.textContent = 'Recheck';
      verifyButton.addEventListener('click', async () => {
        verifyButton.disabled = true;
        try {
          await request(`/api/admin/transactions/${encodeURIComponent(transaction.id)}/reverify`, { method: 'POST', body: '{}' });
          await loadTransactions();
        } catch (error) {
          ledgerNotice.textContent = error.message;
          verifyButton.disabled = false;
        }
      });
      actionCell.append(verifyButton);
    }
    if (transaction.canClose) {
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'secondary';
      closeButton.textContent = 'Mark not paid';
      closeButton.addEventListener('click', async () => {
        if (!window.confirm('Only continue after checking M-Pesa and confirming this request was not paid. Mark it as not paid?')) return;
        closeButton.disabled = true;
        try {
          await request(`/api/admin/transactions/${encodeURIComponent(transaction.id)}/close`, {
            method: 'POST',
            body: JSON.stringify({ confirmNotPaid: true })
          });
          await loadTransactions();
        } catch (error) {
          ledgerNotice.textContent = error.message;
          closeButton.disabled = false;
        }
      });
      actionCell.append(closeButton);
    }
    if (!actionCell.childElementCount) actionCell.textContent = transaction.verificationMessage || '—';
    row.append(actionCell);
    transactionRows.append(row);
  });

  document.getElementById('tableNote').textContent = result.hasMore
    ? 'Showing the latest 1,000 transactions. The CSV export includes all transactions for the selected month.'
    : `${result.transactions.length} transaction(s) in this month.`;
  ledgerNotice.textContent = '';
}

function showLedger() {
  loginPanel.hidden = true;
  ledgerPanel.hidden = false;
  loadTransactions().catch(error => {
    ledgerNotice.textContent = error.message;
    if (error.message.includes('log in')) {
      ledgerPanel.hidden = true;
      loginPanel.hidden = false;
    }
  });
}

monthFilter.value = currentKenyaMonth();

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginNotice.textContent = '';
  const button = loginForm.querySelector('button');
  button.disabled = true;
  try {
    await request('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: document.getElementById('adminPassword').value })
    });
    loginForm.reset();
    showLedger();
  } catch (error) {
    loginNotice.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

monthFilter.addEventListener('change', () => {
  loadTransactions().catch(error => { ledgerNotice.textContent = error.message; });
});

exportButton.addEventListener('click', () => {
  window.location.assign(`/api/admin/transactions.csv?month=${encodeURIComponent(monthFilter.value)}`);
});

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/admin/logout', { method: 'POST', body: '{}' });
    ledgerPanel.hidden = true;
    loginPanel.hidden = false;
  } catch (error) {
    ledgerNotice.textContent = error.message;
  }
});
