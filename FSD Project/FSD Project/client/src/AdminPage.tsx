import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, formatMoney } from './api';
import { useAuth } from './context';

type OrderStatus = 'awaiting_payment' | 'pending' | 'confirmed' | 'rejected' | 'preparing' | 'ready' | 'picked_up' | 'out_for_delivery' | 'delivered' | 'completed' | 'cancelled';
type ReservationStatus = 'pending' | 'confirmed' | 'rejected' | 'seated' | 'completed' | 'cancelled';
type DashboardTab = 'orders' | 'reservations';

interface AdminOrder {
  id: string;
  customerName: string;
  email: string;
  phone: string;
  address: string;
  deliveryInstructions?: string;
  paymentMethod: string;
  paymentStatus: 'unpaid' | 'pending' | 'paid' | 'failed' | 'refund_pending' | 'refunded';
  deliveryFeeCents: number;
  currency: string;
  items: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
}

interface AdminReservation {
  id: string;
  name: string;
  restaurantName: string;
  email: string;
  phone: string;
  date: string;
  time: string;
  guests: number;
  tableId: string;
  currency: string;
  items: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
  preorderTotalCents: number;
  status: ReservationStatus;
  createdAt: string;
}

interface AdminDashboard {
  stats: {
    orderCount: number;
    pendingOrderCount: number;
    reservationCount: number;
    pendingReservationCount: number;
    verifiedSalesCents?: number;
  };
  orders: AdminOrder[];
  reservations: AdminReservation[];
}

const orderTransitions: Record<OrderStatus, OrderStatus[]> = {
  awaiting_payment: ['pending', 'cancelled'], pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'],
  rejected: [], preparing: ['ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'],
  ready: ['picked_up', 'out_for_delivery', 'delivered', 'cancelled'], picked_up: ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'], delivered: ['completed'], completed: [], cancelled: [],
};
const reservationTransitions: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'rejected', 'cancelled'], confirmed: ['seated', 'cancelled'], seated: ['completed'], rejected: [], completed: [], cancelled: [],
};

function statusLabel(status: string): string {
  return status.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = { awaiting_payment: 'Payment pending', pending: 'Received', ready: 'Prepared' };
  return labels[status] || statusLabel(status);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatReservationTime(date: string, time: string): string {
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) return `${date} · ${time}`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(value);
}

interface ManagerAccount {
  id: string;
  name: string;
  email: string;
  username: string;
  restaurantId: string;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  actorName: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  restaurantId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

function AdminAuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ entries: AuditEntry[] }>('/admin/audit-logs').then((result) => setEntries(result.entries)).catch((reason) => setError(reason instanceof Error ? reason.message : 'The activity log could not be loaded.'));
  }, []);
  return <section className="manager-accounts-panel admin-audit-panel"><div className="admin-list-heading"><p>STAFF ACTIVITY</p><span>Latest {entries.length} records</span></div>
    {error && <p className="notice is-error" role="alert">{error}</p>}
    {!error && entries.length === 0 ? <p className="quiet-message">Staff changes will appear here as they happen.</p> : <div className="admin-audit-list">{entries.map((entry) => <article className="admin-audit-entry" key={entry.id}>
      <div><strong>{statusLabel(entry.action)}</strong><span>{entry.actorName} · {entry.actorRole}</span></div>
      <div><span>{statusLabel(entry.resourceType)} · {entry.resourceId}</span><small>{entry.restaurantId || 'Platform'}</small></div>
      <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
    </article>)}</div>}
  </section>;
}

function ManagerAccountsPanel() {
  const [managers, setManagers] = useState<ManagerAccount[]>([]);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setManagers((await api<{ managers: ManagerAccount[] }>('/admin/managers')).managers); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Manager accounts could not be loaded.'); setError(true); }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    setSaving(true); setNotice(''); setTemporaryPassword(''); setError(false);
    try {
      const result = await api<{ message: string; temporaryPassword: string }>('/admin/managers', { method: 'POST', body: JSON.stringify({ name: fields.get('managerName'), email: fields.get('managerEmail'), username: fields.get('managerUsername') }) });
      setTemporaryPassword(result.temporaryPassword); setNotice(result.message); form.reset(); await load();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The manager account could not be created.'); setError(true); }
    finally { setSaving(false); }
  }

  async function setActive(manager: ManagerAccount, active: boolean) {
    setNotice(''); setTemporaryPassword(''); setError(false);
    try { const result = await api<{ message: string }>(`/admin/managers/${encodeURIComponent(manager.id)}`, { method: 'PATCH', body: JSON.stringify({ active }) }); setNotice(result.message); await load(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The manager account could not be updated.'); setError(true); }
  }

  async function resetPassword(manager: ManagerAccount) {
    setNotice(''); setTemporaryPassword(''); setError(false);
    try { const result = await api<{ message: string; temporaryPassword: string }>(`/admin/managers/${encodeURIComponent(manager.id)}/reset-password`, { method: 'POST' }); setTemporaryPassword(result.temporaryPassword); setNotice(result.message); await load(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The manager password could not be reset.'); setError(true); }
  }

  return <section className="manager-accounts-panel admin-workspace">
    <div className="admin-list-heading"><p>RESTAURANT MANAGERS</p><span>{managers.length} accounts</span></div>
    <p className={'notice' + (error ? ' is-error' : notice ? ' is-success' : '')} role="status">{notice}</p>
    {temporaryPassword && <div className="temporary-credential"><strong>Temporary password — shown once</strong><code>{temporaryPassword}</code><p>Share this password with the manager through a secure channel. They must replace it on first sign in.</p></div>}
    <form className="form-card manager-create-form" onSubmit={create}>
      <h2>Create a manager account</h2><p className="fine-print">The account is assigned to Foodie Table. The manager sets a new password at first sign in.</p>
      <label htmlFor="manager-name">Manager name</label><input id="manager-name" name="managerName" maxLength={100} required />
      <label htmlFor="manager-email">Email</label><input id="manager-email" name="managerEmail" type="email" maxLength={254} required />
      <label htmlFor="manager-username">Staff username</label><input id="manager-username" name="managerUsername" minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" required />
      <button className="button button-reserve" type="submit" disabled={saving}>{saving ? 'Creating account…' : 'Create manager account'}</button>
    </form>
    <div className="manager-account-list">{managers.map((manager) => <article className="admin-record" key={manager.id}>
      <div className="admin-record-top"><div><p className="eyebrow">{manager.active ? 'ACTIVE MANAGER' : 'SUSPENDED MANAGER'}</p><h3>{manager.name}</h3><p>{manager.email} · Username: {manager.username}</p></div><span className="order-status-badge">{manager.mustChangePassword ? 'Password reset required' : 'Password set'}</span></div>
      <div className="button-row"><button className="button button-outline-dark" type="button" onClick={() => void setActive(manager, !manager.active)}>{manager.active ? 'Suspend access' : 'Reactivate access'}</button><button className="button button-outline-dark" type="button" onClick={() => void resetPassword(manager)}>Reset password</button></div>
    </article>)}</div>
  </section>;
}

function ManagerPasswordChange() {
  const { refresh } = useAuth();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    setSaving(true); setNotice(''); setError(false);
    try { const result = await api<{ message: string }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: fields.get('currentPassword'), newPassword: fields.get('newPassword') }) }); setNotice(result.message); form.reset(); await refresh(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Your password could not be updated.'); setError(true); }
    finally { setSaving(false); }
  }
  return <div className="section-wrap page-content narrow-content"><p className="eyebrow">FIRST SIGN IN</p><h1>Set a new password.</h1><p>For account security, replace the temporary password before using the manager desk.</p><p className={'notice' + (error ? ' is-error' : notice ? ' is-success' : '')} role="status">{notice}</p><form className="form-card" onSubmit={submit}><label htmlFor="manager-current-password">Temporary password</label><input id="manager-current-password" name="currentPassword" type="password" autoComplete="current-password" required /><label htmlFor="manager-new-password">New password</label><input id="manager-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={10} required /><p className="fine-print">Use at least 10 characters.</p><button className="button button-reserve button-full" type="submit" disabled={saving}>{saving ? 'Updating…' : 'Set new password'}</button></form></div>;
}

function ManagerTools() {
  type MenuItem = { id: string; name: string; category: string; description: string; priceCents: number; active: boolean; isVegetarian: boolean };
  type Table = { id: string; section: 'A' | 'B' | 'C'; seats: number; row: number; column: number; active: boolean };
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  async function load() {
    try { const [menuResult, tableResult] = await Promise.all([api<{ products: MenuItem[] }>('/manager/menu'), api<{ tables: Table[] }>('/manager/tables')]); setMenu(menuResult.products); setTables(tableResult.tables); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Manager settings could not be loaded.'); setError(true); }
  }
  useEffect(() => { void load(); }, []);
  async function updateMenu(id: string, changes: Partial<MenuItem>) {
    setNotice(''); setError(false);
    try { const result = await api<{ product: MenuItem }>('/manager/menu/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(changes) }); setMenu((current) => current.map((entry) => entry.id === id ? result.product : entry)); setNotice(`${result.product.name} updated.`); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Menu item could not be updated.'); setError(true); }
  }
  function editMenuField<K extends keyof MenuItem>(id: string, field: K, value: MenuItem[K]) {
    setMenu((current) => current.map((entry) => entry.id === id ? { ...entry, [field]: value } : entry));
  }
  async function addMenuItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    setNotice(''); setError(false);
    const fields = new FormData(form);
    try { const result = await api<{ message: string; product: MenuItem }>('/manager/menu', { method: 'POST', body: JSON.stringify({ name: fields.get('menuName'), category: fields.get('menuCategory'), description: fields.get('menuDescription'), priceCents: Number(fields.get('menuPrice')), isVegetarian: fields.get('menuVegetarian') === 'on', imageUrl: String(fields.get('menuImage') || '') }) }); setMenu((current) => [...current, result.product]); setNotice(result.message); form.reset(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Menu item could not be added.'); setError(true); }
  }
  async function updateTable(table: Table, changes: Partial<Table>) {
    setNotice(''); setError(false);
    try { const result = await api<{ table: Table }>(`/manager/tables/${encodeURIComponent(table.id)}`, { method: 'PATCH', body: JSON.stringify(changes) }); setTables((current) => current.map((entry) => entry.id === table.id ? result.table : entry)); setNotice(`${table.id} updated.`); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Table could not be updated.'); setError(true); }
  }
  async function addTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    setNotice(''); setError(false);
    const fields = new FormData(form);
    try { const result = await api<{ message: string; table: Table }>('/manager/tables', { method: 'POST', body: JSON.stringify({ section: fields.get('section'), seats: Number(fields.get('seats')), row: Number(fields.get('row')), column: Number(fields.get('column')) }) }); setTables((current) => [...current, result.table]); setNotice(result.message); form.reset(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Table could not be added.'); setError(true); }
  }
  return <section className="manager-tools admin-workspace"><div className="admin-list-heading"><p>RESTAURANT SETUP</p><span>Foodie Table</span></div><p className={'notice' + (error ? ' is-error' : notice ? ' is-success' : '')} role="status">{notice}</p>
    <div className="manager-tools-grid"><section><h2>Menu management</h2>{menu.map((item) => <article className="manager-menu-card" key={item.id}>
      <div className="manager-menu-fields"><label>Dish name<input value={item.name} maxLength={100} onChange={(event) => editMenuField(item.id, 'name', event.currentTarget.value)} /></label><label>Category<select value={item.category} onChange={(event) => editMenuField(item.id, 'category', event.currentTarget.value)}>{['Appetizers', 'Biryani', 'Entrees', 'Desserts'].map((category) => <option key={category}>{category}</option>)}</select></label><label>Description<input value={item.description} maxLength={500} onChange={(event) => editMenuField(item.id, 'description', event.currentTarget.value)} /></label><label>Price in paise<input type="number" min="1" step="1" value={item.priceCents} onChange={(event) => editMenuField(item.id, 'priceCents', Number(event.currentTarget.value))} /></label><label className="saved-address-default"><input type="checkbox" checked={item.isVegetarian} onChange={(event) => editMenuField(item.id, 'isVegetarian', event.currentTarget.checked)} /> Vegetarian</label></div>
      <div className="button-row"><button className="button button-reserve" type="button" onClick={() => void updateMenu(item.id, { name: item.name, category: item.category, description: item.description, priceCents: item.priceCents, isVegetarian: item.isVegetarian })}>Save changes</button><button className="button button-outline-dark" type="button" onClick={() => void updateMenu(item.id, { active: !item.active })}>{item.active ? 'Mark unavailable' : 'Restore to menu'}</button></div>
    </article>)}
      <form className="manager-add-table" onSubmit={addMenuItem}><h3>Add menu item</h3><label>Dish name<input name="menuName" maxLength={100} required /></label><label>Category<select name="menuCategory"><option>Appetizers</option><option>Biryani</option><option>Entrees</option><option>Desserts</option></select></label><label>Description<input name="menuDescription" maxLength={500} required /></label><label>Price in paise<input name="menuPrice" type="number" min="1" step="1" required /></label><label>Image URL<input name="menuImage" type="url" placeholder="https://…" /></label><label className="saved-address-default"><input type="checkbox" name="menuVegetarian" /> Vegetarian</label><button className="button button-reserve" type="submit">Add dish</button></form>
    </section>
      <section><h2>Tables and seating</h2>{tables.map((table) => <article className="manager-tool-row" key={table.id}><strong>{table.id} · Section {table.section}</strong><label><span className="visually-hidden">Capacity for {table.id}</span><select value={table.seats} onChange={(event) => void updateTable(table, { seats: Number(event.currentTarget.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((seats) => <option key={seats} value={seats}>{seats} seats</option>)}</select></label><button className="button button-outline-dark" type="button" onClick={() => void updateTable(table, { active: !table.active })}>{table.active ? 'Active' : 'Disabled'}</button></article>)}<form className="manager-add-table" onSubmit={addTable}><h3>Add table</h3><label>Section<select name="section"><option>A</option><option>B</option><option>C</option></select></label><label>Seats<select name="seats">{[2, 4, 6, 8].map((seats) => <option key={seats} value={seats}>{seats}</option>)}</select></label><label>Row<select name="row"><option value="1">1</option><option value="2">2</option></select></label><label>Column<select name="column"><option value="1">1</option><option value="2">2</option></select></label><button className="button button-reserve" type="submit">Add table</button></form></section></div>
  </section>;
}

export function AdminPage() {
  const { user, ready } = useAuth();
  const isManager = user?.role === 'manager';
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [tab, setTab] = useState<DashboardTab>('orders');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);

  const loadDashboard = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setNotice(''); setNoticeError(false);
    }
    try {
      setDashboard(await api<AdminDashboard>(isManager ? '/manager/dashboard' : '/admin/dashboard'));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'The admin dashboard could not be loaded.');
      setNoticeError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [isManager]);

  useEffect(() => {
    if (ready && (user?.role === 'admin' || user?.role === 'manager') && !user.mustChangePassword) void loadDashboard();
    else if (ready) setLoading(false);
  }, [ready, user?.role, user?.mustChangePassword, loadDashboard]);

  const visibleOrders = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (dashboard?.orders || []).filter((order) =>
      (statusFilter === 'all' || order.status === statusFilter)
      && (!needle || [order.customerName, order.email, order.phone, order.id, ...(order.items || []).map((item) => item.name)].some((value) => value.toLowerCase().includes(needle))),
    );
  }, [dashboard?.orders, search, statusFilter]);

  const visibleReservations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (dashboard?.reservations || []).filter((reservation) =>
      (statusFilter === 'all' || reservation.status === statusFilter)
      && (!needle || [reservation.name, reservation.restaurantName, reservation.email, reservation.phone, reservation.tableId, reservation.id, ...(reservation.items || []).map((item) => item.name)].some((value) => (value ?? '').toLowerCase().includes(needle))),
    );
  }, [dashboard?.reservations, search, statusFilter]);

  async function updateStatus(kind: DashboardTab, id: string, status: string) {
    setSavingId(`${kind}:${id}`); setNotice(''); setNoticeError(false);
    try {
      const collection = kind === 'orders' ? 'orders' : 'reservations';
      const result = await api<{ message: string }>(`${isManager ? '/manager' : '/admin'}/${collection}/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      });
      setNotice(result.message);
      await loadDashboard(true);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'The status could not be updated.');
      setNoticeError(true);
    } finally {
      setSavingId('');
    }
  }

  if (!ready) return <div className="section-wrap page-content narrow-content"><p className="quiet-message">Checking your access…</p></div>;
  if (!user) return <div className="section-wrap page-content narrow-content admin-access-message"><p className="eyebrow">FOODIE TABLE · STAFF</p><h1>Staff access only.</h1><p>Sign in with the administrator username to review orders and table requests.</p><Link className="button button-reserve" to="/admin/login">Admin sign in</Link></div>;
  if (user.role === 'manager' && user.mustChangePassword) return <ManagerPasswordChange />;
  if (user.role !== 'admin' && user.role !== 'manager') return <div className="section-wrap page-content narrow-content admin-access-message"><p className="eyebrow">FOODIE TABLE · STAFF</p><h1>Staff access only.</h1><p>This account is not assigned staff access. Use the designated staff username to open the service desk.</p><Link className="button button-outline-dark" to="/admin/login">Switch to staff sign in</Link></div>;

  const activeCount = tab === 'orders' ? dashboard?.orders.length || 0 : dashboard?.reservations.length || 0;
  const displayedCount = tab === 'orders' ? visibleOrders.length : visibleReservations.length;

  return (
    <div className="admin-page section-wrap page-content">
      <header className="admin-header">
        <div><p className="eyebrow">FOODIE TABLE · {isManager ? 'MANAGER DESK' : 'ADMIN DESK'}</p><h1>Service, at a glance.</h1><p>Review incoming orders and table requests, then keep each status current for the team.</p></div>
        <button className="button button-outline-dark admin-refresh" type="button" onClick={() => void loadDashboard()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh list'}</button>
      </header>

      <div className="admin-stats" aria-label="Service totals">
        <article><span>All orders</span><strong>{dashboard?.stats.orderCount ?? '—'}</strong><small>{dashboard?.stats.pendingOrderCount ?? '—'} awaiting action</small></article>
        <article><span>All reservations</span><strong>{dashboard?.stats.reservationCount ?? '—'}</strong><small>{dashboard?.stats.pendingReservationCount ?? '—'} awaiting action</small></article>
        <article><span>Orders in history</span><strong>{dashboard?.orders.length ?? '—'}</strong><small>Full order history</small></article>
        <article><span>Recent reservations</span><strong>{dashboard?.reservations.length ?? '—'}</strong><small>Latest 100 shown</small></article>
        {isManager && <article><span>Verified sales</span><strong>{formatMoney(dashboard?.stats.verifiedSalesCents || 0)}</strong><small>Captured online orders</small></article>}
      </div>

      <div className="admin-workspace">
        <div className="admin-toolbar">
          <div className="admin-tabs" role="tablist" aria-label="Choose a service list">
            <button type="button" role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'is-active' : ''} onClick={() => { setTab('orders'); setStatusFilter('all'); }}>Orders <span>{dashboard?.stats.orderCount ?? 0}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'reservations'} className={tab === 'reservations' ? 'is-active' : ''} onClick={() => { setTab('reservations'); setStatusFilter('all'); }}>Reservations <span>{dashboard?.stats.reservationCount ?? 0}</span></button>
          </div>
          <div className="admin-filters">
            <label><span className="visually-hidden">Search this list</span><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Name, email, table or dish" /></label>
            <label><span className="visually-hidden">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="all">All statuses</option>{Object.keys(tab === 'orders' ? orderTransitions : reservationTransitions).map((status) => <option key={status} value={status}>{tab === 'orders' ? orderStatusLabel(status) : statusLabel(status)}</option>)}</select></label>
          </div>
        </div>

        <div className="admin-list-heading"><p>{tab === 'orders' ? 'CUSTOMER ORDERS' : 'TABLE RESERVATIONS'}</p><span>{displayedCount} shown</span></div>
        <div className="admin-feedback" aria-live="polite">
          {loading && <p className="quiet-message">Gathering the latest records…</p>}
          <p className={'notice' + (noticeError ? ' is-error' : notice ? ' is-success' : '')} role="status">{notice}</p>
        </div>

        {!loading && tab === 'orders' && visibleOrders.length === 0 && <div className="admin-empty"><p className="eyebrow">A QUIET MOMENT</p><h2>No matching orders.</h2><p>New customer orders will appear here when they are submitted.</p></div>}
        {!loading && tab === 'orders' && visibleOrders.length > 0 && <div className="admin-record-list">
          {visibleOrders.map((order) => <article className="admin-record" key={order.id}>
            <div className="admin-record-top"><div><p className="eyebrow">ORDER · {order.id.slice(-8).toUpperCase()}</p><h2>{order.customerName}</h2><p className="admin-created">Placed {formatDateTime(order.createdAt)}</p></div>
              <label className="admin-status-control"><span>Order status</span><select value={order.status} disabled={savingId === `orders:${order.id}` || orderTransitions[order.status].length === 0} onChange={(event) => void updateStatus('orders', order.id, event.currentTarget.value)}><option value={order.status}>{orderStatusLabel(order.status)}</option>{orderTransitions[order.status].map((status) => <option key={status} value={status}>{orderStatusLabel(status)}</option>)}</select></label>
            </div>
            <div className="admin-record-details"><p><span>Email</span><a href={`mailto:${order.email}`}>{order.email}</a></p><p><span>Phone</span><a href={`tel:${order.phone}`}>{order.phone}</a></p><p><span>Delivery address</span><strong>{order.address}</strong></p>{order.deliveryInstructions && <p><span>Delivery instructions</span><strong>{order.deliveryInstructions}</strong></p>}<p><span>Payment method</span><strong>{order.paymentMethod === 'razorpay' ? 'Online · Razorpay' : order.paymentMethod === 'demo_online' ? 'Online · Demo (no charge)' : 'Cash on delivery'}</strong></p><p><span>Payment status</span><strong className={`payment-status-text is-${order.paymentStatus}`}>{statusLabel(order.paymentStatus)}</strong></p></div>
            <ul className="admin-items">{(order.items || []).map((item) => <li key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{formatMoney(item.priceCents * item.quantity, order.currency)}</strong></li>)}</ul>
            <div className="admin-record-total"><span>Order total</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></div>
          </article>)}
        </div>}

        {!loading && tab === 'reservations' && visibleReservations.length === 0 && <div className="admin-empty"><p className="eyebrow">A QUIET MOMENT</p><h2>No matching reservations.</h2><p>Table requests from the reservation page will appear here.</p></div>}
        {!loading && tab === 'reservations' && visibleReservations.length > 0 && <div className="admin-record-list">
          {visibleReservations.map((reservation) => <article className="admin-record" key={reservation.id}>
            <div className="admin-record-top"><div><p className="eyebrow">TABLE REQUEST · {reservation.tableId} · {reservation.id.slice(-8).toUpperCase()}</p><h2>{reservation.name}</h2><p className="admin-created">{reservation.restaurantName} · Requested {formatDateTime(reservation.createdAt)}</p></div>
              <label className="admin-status-control"><span>Visit status</span><select value={reservation.status} disabled={savingId === `reservations:${reservation.id}` || reservationTransitions[reservation.status].length === 0} onChange={(event) => void updateStatus('reservations', reservation.id, event.currentTarget.value)}><option value={reservation.status}>{statusLabel(reservation.status)}</option>{reservationTransitions[reservation.status].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
            </div>
            <div className="reservation-admin-highlight"><div><span>Visit</span><strong>{formatReservationTime(reservation.date, reservation.time)}</strong></div><div><span>Table number</span><strong>{reservation.tableId}</strong></div><div><span>Party</span><strong>{reservation.guests} {reservation.guests === 1 ? 'guest' : 'guests'}</strong></div></div>
            {reservation.status === 'pending' && <div className="reservation-approval-row"><p>The table is held while this request is pending. Approve it to confirm the customer’s table.</p><button className="button button-reserve button-small" type="button" disabled={savingId === `reservations:${reservation.id}` || reservation.tableId === 'Table not assigned'} onClick={() => void updateStatus('reservations', reservation.id, 'confirmed')}>{savingId === `reservations:${reservation.id}` ? 'Approving…' : `Approve ${reservation.tableId}`}</button></div>}
            <div className="admin-record-details"><p><span>Email</span><a href={`mailto:${reservation.email}`}>{reservation.email}</a></p><p><span>Phone</span><a href={`tel:${reservation.phone}`}>{reservation.phone}</a></p></div>
            <div className="admin-preorder"><span>Pre-order</span><p>{(reservation.items || []).length ? (reservation.items || []).map((item) => `${item.quantity} × ${item.name}`).join(' · ') : 'No dishes ordered ahead'}</p>{reservation.preorderTotalCents > 0 && <strong>{formatMoney(reservation.preorderTotalCents, reservation.currency)}</strong>}</div>
          </article>)}
        </div>}
        {activeCount > 100 && <p className="admin-limit-note">Showing the latest 100 {tab}; refine by status or search to find a record.</p>}
    </div>
      {isManager && <ManagerTools />}
      {user.role === 'admin' && <><ManagerAccountsPanel /><AdminAuditPanel /></>}
    </div>
  );
}
