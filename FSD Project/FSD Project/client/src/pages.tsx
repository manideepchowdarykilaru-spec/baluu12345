import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, formatMoney } from './api';
import { useAuth, useCart } from './context';
import type { CustomerAddress, DeliveryPaymentConfig, MenuResponse, OrderResponse, PaymentMethod, Product } from './types';

const TAX_RATE = 0.08;

interface RazorpayCheckoutResult {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: { name: string; email: string; contact: string };
  theme: { color: string };
  handler: (result: RazorpayCheckoutResult) => void;
  modal: { ondismiss: () => void };
}

interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: 'payment.failed', listener: (result: { error?: { description?: string } }) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
  }
}

let razorpayScriptPromise: Promise<void> | null = null;

function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => window.Razorpay ? resolve() : reject(new Error('Online checkout could not be loaded.'));
      script.onerror = () => reject(new Error('Online checkout could not be loaded. Check your connection or use cash on delivery.'));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      razorpayScriptPromise = null;
      throw error;
    });
  }
  return razorpayScriptPromise;
}

function readSavedOrder(key: string): OrderResponse | null {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!saved || typeof saved !== 'object' || !('order' in saved)) return null;
    const candidate = saved as OrderResponse;
    if (!candidate.order?.id || !candidate.order?.trackingToken) return null;
    if (candidate.order.currency !== 'USD' || candidate.order.paymentMethod === 'razorpay') return candidate;
    const items = candidate.order.items.map((item) => ({ ...item, priceCents: Math.round(item.priceCents * 95 / 1000) * 1000 }));
    const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const deliveryFeeCents = Math.round(candidate.order.deliveryFeeCents * 95 / 1000) * 1000;
    const normalized: OrderResponse = {
      ...candidate,
      order: {
        ...candidate.order,
        items,
        subtotalCents,
        taxCents,
        deliveryFeeCents,
        totalCents: subtotalCents + taxCents + deliveryFeeCents,
        currency: 'INR',
      },
      payment: candidate.payment?.provider === 'demo'
        ? { ...candidate.payment, amount: subtotalCents + taxCents + deliveryFeeCents, currency: 'INR' }
        : candidate.payment,
    };
    saveOrder(key, normalized);
    return normalized;
  } catch {
    return null;
  }
}

function saveOrder(key: string, order: OrderResponse | null): void {
  try {
    if (order) sessionStorage.setItem(key, JSON.stringify(order));
    else sessionStorage.removeItem(key);
  } catch { /* Checkout remains usable if browser storage is unavailable. */ }
}

interface TableOption {
  id: string;
  section: 'A' | 'B' | 'C';
  seats: number;
  row: number;
  column: number;
  available: boolean;
}

interface RestaurantOption {
  id: string;
  name: string;
}

interface ReservationConfirmation {
  message: string;
  trackingToken: string;
  restaurantName?: string;
  date: string;
  time: string;
  guests: number;
  reservation: {
    id: string;
    tableId: string;
    section: string;
    seats: number;
    status: 'pending' | 'confirmed' | 'rejected' | 'seated' | 'completed' | 'cancelled';
    currency: string;
    items: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
    preorderTotalCents: number;
  };
}

function loadSavedReservation(): ReservationConfirmation | null {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem('juniper-table-reservation-status') || 'null');
    if (!saved || typeof saved !== 'object' || !('trackingToken' in saved) || !('reservation' in saved)) return null;
    const confirmation = saved as ReservationConfirmation;
    if (confirmation.reservation.currency === 'INR') return confirmation;
    const items = confirmation.reservation.items.map((item) => ({ ...item, priceCents: Math.round(item.priceCents * 95 / 1000) * 1000 }));
    const preorderTotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    const normalized = { ...confirmation, reservation: { ...confirmation.reservation, items, preorderTotalCents, currency: 'INR' } };
    sessionStorage.setItem('juniper-table-reservation-status', JSON.stringify(normalized));
    return normalized;
  } catch {
    return null;
  }
}

function saveReservation(confirmation: ReservationConfirmation): void {
  try { sessionStorage.setItem('juniper-table-reservation-status', JSON.stringify(confirmation)); }
  catch { /* Status updates still work while this page remains open. */ }
}

const photography = {
  biryani: {
    src: '/images/biryani.jpg',
    alt: 'A bowl of biryani with rice, chicken and spices',
    credit: 'Mario Raj',
    href: 'https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw',
  },
  springRolls: {
    src: '/images/spring-rolls.jpg',
    alt: 'Fried spring rolls arranged in a serving pan',
    credit: 'Joshua Hoehne',
    href: 'https://unsplash.com/photos/fried-spring-rolls-broMfoJ0Emg',
  },
  cheesecake: {
    src: '/images/cheesecake.jpg',
    alt: 'A layered cheesecake slice displayed on a wooden board',
    credit: 'Omar Hakeem',
    href: 'https://unsplash.com/photos/a-slice-of-layered-cheesecake-with-blueberries-and-swirl-topping-A3va7XiljlQ',
  },
  curry: {
    src: '/images/curry.jpg',
    alt: 'Chicken curry with mint and naan bread',
    credit: 'Mohammad Fahim',
    href: 'https://unsplash.com/photos/creamy-chicken-curry-with-fresh-mint-and-naan-bread-vl2y3qoKq3E',
  },
  room: {
    src: '/images/room.jpg',
    alt: 'A softly lit restaurant interior with a warm, intimate feel',
    credit: 'vnwayne fan',
    href: 'https://unsplash.com/photos/restaurant-interior-xpzICNSaVUs',
  },
  roomTwo: {
    src: '/images/room-evening.jpg',
    alt: 'Restaurant tables set for an evening meal',
    credit: 'Jason Leung',
    href: 'https://unsplash.com/photos/cozy-restaurant-alleyway-with-tables-and-warm-lighting-nsKPOIqaGbQ',
  },
} as const;

const menuCategories = [
  { id: 'appetizers', name: 'Appetizers', description: 'Small plates to begin the meal.', photo: photography.springRolls },
  { id: 'biryani', name: 'Biryani', description: 'Fragrant rice and comforting spices.', photo: photography.biryani },
  { id: 'entrees', name: 'Entrees', description: 'Satisfying plates from the kitchen.', photo: photography.curry },
  { id: 'desserts', name: 'Desserts', description: 'A sweet ending to the meal.', photo: photography.cheesecake },
];

const galleryPhotos = [
  { ...photography.biryani, title: 'A bowl for sharing', shape: 'gallery-tall' },
  { ...photography.room, title: 'An easy evening', shape: 'gallery-wide' },
  { ...photography.springRolls, title: 'Something crisp to start', shape: '' },
  { ...photography.curry, title: 'Warm spices, bright herbs', shape: 'gallery-wide' },
  { ...photography.cheesecake, title: 'A little something sweet', shape: '' },
  { ...photography.roomTwo, title: 'Room at the table', shape: 'gallery-tall' },
];

function useMenu() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api<MenuResponse>('/menu')
      .then((menu) => { if (active) setProducts(menu.products); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'The menu could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return { products, loading, error };
}

function Status({ message, error = false }: { message: string; error?: boolean }) {
  return <p className={'notice' + (error ? ' is-error' : message ? ' is-success' : '')} role="status" aria-live="polite">{message}</p>;
}

function PageIntro({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <div className="page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children && <p className="page-lede">{children}</p>}</div>;
}

function Photo({
  image,
  className = '',
  eager = false,
}: {
  image: { src: string; alt: string; credit: string; href: string };
  className?: string;
  eager?: boolean;
}) {
  const [unavailable, setUnavailable] = useState(false);
  return (
    <figure className={`photo ${className}`}>
      {unavailable ? (
        <div className="photo-unavailable" role="img" aria-label={`${image.alt}. Representative photography placeholder.`}>
          <span>Restaurant photography to come</span>
        </div>
      ) : (
        <img
          src={image.src}
          alt={image.alt}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          onError={() => setUnavailable(true)}
        />
      )}
      <figcaption>Representative photo · <a href={image.href} target="_blank" rel="noreferrer">{image.credit} / Unsplash</a></figcaption>
    </figure>
  );
}

function localDateValue(date = new Date()): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function HomePage() {
  const { products, loading, error } = useMenu();
  const { addItem, items } = useCart();
  const [cartMessage, setCartMessage] = useState('');
  const featured = useMemo(() => {
    const preferred = ['chicken-biryani', 'spring-rolls', 'cheesecake']
      .map((id) => products.find((product) => product.id === id))
      .filter((product): product is Product => Boolean(product));
    return preferred.length ? preferred : products.slice(0, 3);
  }, [products]);

  function addFeatured(product: Product) {
    if ((items[product.id] || 0) >= 10) {
      setCartMessage('You can add up to 10 of each item.');
      return;
    }
    addItem(product.id);
    setCartMessage(`${product.name} added to your bag.`);
  }

  function imageForProduct(product: Product) {
    if (product.id.includes('roll')) return photography.springRolls;
    if (product.id.includes('cheesecake')) return photography.cheesecake;
    if (product.id.includes('biryani')) return photography.biryani;
    return photography.curry;
  }

  return (
    <>
      <section className="hero-editorial">
        <div className="hero-copy">
          <p className="eyebrow">FOODIE TABLE <span>·</span> A NEIGHBORHOOD KITCHEN</p>
          <h1>Good food.<br /><em>Room for one more.</em></h1>
          <p>A table for crisp first bites, fragrant biryani and a little something sweet. Come hungry; settle in.</p>
          <div className="button-row">
            <Link className="button button-reserve" to="/menu">Explore the menu</Link>
            <Link className="button button-text" to="/reservations">Reserve a table <span aria-hidden="true">↗</span></Link>
          </div>
          <p className="hero-detail"><span className="detail-rule" /> A neighborhood-table point of view</p>
        </div>
        <Photo image={photography.biryani} className="hero-photo" eager />
        <span className="hero-index" aria-hidden="true">01 / 04</span>
      </section>

      <section className="intro-ribbon" aria-label="About Foodie Table">
        <span>Comforting plates</span><i aria-hidden="true">✳</i><span>Bright, warm flavors</span><i aria-hidden="true">✳</i><span>Made for sharing</span>
      </section>

      <section className="section-wrap signature-section">
        <div className="section-heading">
          <div><p className="eyebrow">A FEW THINGS WE LOVE</p><h2>From the table</h2></div>
          <Link className="text-link" to="/menu">See the whole menu <span aria-hidden="true">↗</span></Link>
        </div>
        {loading && <p className="quiet-message">Setting the table…</p>}
        {error && <Status message={error} error />}
        {!loading && !error && <div className="signature-grid">
          {featured.map((product, index) => <article className={`signature-card signature-card-${index + 1}`} key={product.id}>
            <Photo image={imageForProduct(product)} className="signature-photo" />
            <div className="signature-copy">
              <div><span className="item-category">{product.category}</span><h3>{product.name}</h3></div>
              <p>{product.description}</p>
              <div className="signature-bottom"><strong>{formatMoney(product.priceCents)}</strong><button type="button" className="add-link" onClick={() => addFeatured(product)} aria-label={`Add ${product.name} to bag`}>Add to bag <span aria-hidden="true">+</span></button></div>
            </div>
          </article>)}
        </div>}
        <Status message={cartMessage} />
      </section>

      <section className="story-band">
        <Photo image={photography.room} className="story-band-photo" />
        <div className="story-band-copy">
          <p className="eyebrow">A TABLE WITH A POINT OF VIEW</p>
          <h2>Familiar, with a little spark.</h2>
          <p>Foodie Table brings together the comfort of a generous meal and the bright lift of good spice. Think shared starters, fragrant rice and an unhurried last bite.</p>
          <Link className="button button-outline-dark" to="/story">A little about us <span aria-hidden="true">↗</span></Link>
        </div>
      </section>

      <section className="section-wrap category-section">
        <div className="category-intro">
          <p className="eyebrow">WHAT SOUNDS GOOD?</p>
          <h2>Start wherever<br />you like.</h2>
          <p>From a small plate to a slow supper, find the part of the menu that calls to you.</p>
          <Link className="text-link" to="/categories">Browse by course <span aria-hidden="true">↗</span></Link>
        </div>
        <div className="category-list">
          {menuCategories.map((category, index) => <Link className="category-row" key={category.id} to={`/menu#${category.id}`}>
            <span className="category-number">0{index + 1}</span><span className="category-title">{category.name}</span><span className="category-description">{category.description}</span><span className="category-arrow" aria-hidden="true">↗</span>
          </Link>)}
        </div>
      </section>

      <section className="gallery-teaser">
        <div className="gallery-teaser-copy"><p className="eyebrow">A LITTLE LOOK AROUND</p><h2>Good things,<br /><em>gathered close.</em></h2><Link className="button button-outline" to="/gallery">Visit the gallery <span aria-hidden="true">↗</span></Link></div>
        <Photo image={photography.springRolls} className="gallery-teaser-photo gallery-teaser-one" />
        <Photo image={photography.cheesecake} className="gallery-teaser-photo gallery-teaser-two" />
        <Photo image={photography.roomTwo} className="gallery-teaser-photo gallery-teaser-three" />
      </section>

      <section className="reservation-banner">
        <p className="eyebrow">SAVE A PLACE AT THE TABLE</p>
        <h2>Make an evening of it.</h2>
        <p>Send a reservation request and we’ll be in touch to confirm the details.</p>
        <Link className="button button-cream" to="/reservations">Request a table <span aria-hidden="true">↗</span></Link>
      </section>
    </>
  );
}

export function StoryPage() {
  return (
    <div className="story-page">
      <section className="story-page-intro section-wrap">
        <p className="eyebrow">OUR STORY</p>
        <h1>A good meal<br /><em>makes room.</em></h1>
        <p className="page-lede">For the first bite, the second helping, and the conversation that runs past dessert.</p>
      </section>
      <section className="story-page-feature">
        <Photo image={photography.room} className="story-page-photo" />
        <div className="story-page-copy">
          <p className="eyebrow">THE FOODIE TABLE WAY</p>
          <h2>Comfort, with a little brightness.</h2>
          <p>Our menu moves from crisp starters to fragrant biryani, then leaves space for something sweet. It’s food with a generous spirit: familiar enough to feel easy, vivid enough to remember.</p>
          <p>We believe a neighborhood table should welcome different appetites and make it simple to share. Pick a favorite, pass a plate, and stay for one more story.</p>
          <Link className="text-link" to="/menu">Explore what’s cooking <span aria-hidden="true">↗</span></Link>
        </div>
      </section>
      <section className="story-note section-wrap">
        <span className="story-note-mark" aria-hidden="true">F</span>
        <p>“There’s always room at the table.”</p>
        <span className="photo-disclosure">A note on the photographs: these are representative Unsplash images. Foodie Table’s own room and dish photography has not yet been supplied.</span>
      </section>
      <section className="story-cta"><p className="eyebrow">COME AS YOU ARE</p><h2>There’s a place for you.</h2><Link className="button button-reserve" to="/reservations">Request a table</Link></section>
    </div>
  );
}

export function GalleryPage() {
  return (
    <div className="gallery-page section-wrap">
      <PageIntro eyebrow="A LITTLE LOOK AROUND" title="At the table">A glimpse of the dishes and atmosphere that inspire Foodie Table.</PageIntro>
      <p className="gallery-disclosure">Representative food and restaurant photography by Unsplash contributors. Replace with Foodie Table’s own photographs when available.</p>
      <div className="gallery-grid">
        {galleryPhotos.map((image, index) => <figure className={`gallery-item ${image.shape}`} key={`${image.credit}-${image.title}`}>
          <Photo image={image} className="gallery-image" />
          <figcaption className="gallery-caption"><span>0{index + 1}</span><strong>{image.title}</strong></figcaption>
        </figure>)}
      </div>
    </div>
  );
}

export function CategoriesPage() {
  return (
    <div className="section-wrap page-content categories-page">
      <PageIntro eyebrow="FIND YOUR CRAVING" title="Browse by course">Choose a section, then add your favorites straight to your bag.</PageIntro>
      <div className="category-tile-grid">
        {menuCategories.map((category, index) => <Link className={`category-tile category-tile-${index + 1}`} key={category.id} to={`/menu#${category.id}`}>
          <Photo image={category.photo} className="category-tile-photo" />
          <span className="category-tile-number">0{index + 1}</span><span className="category-tile-title">{category.name}</span><span className="category-tile-arrow" aria-hidden="true">↗</span>
        </Link>)}
      </div>
    </div>
  );
}

export function MenuPage() {
  const { products, loading, error } = useMenu();
  const { addItem, items } = useCart();
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [search, setSearch] = useState('');
  const [vegetarianOnly, setVegetarianOnly] = useState(false);
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return menuCategories.map((category) => ({
      ...category,
      products: products.filter((product) => {
        const matchesText = !needle || `${product.name} ${product.description} ${product.category}`.toLowerCase().includes(needle);
        return product.category.toLowerCase() === category.name.toLowerCase() && (!vegetarianOnly || Boolean(product.isVegetarian)) && matchesText;
      }),
    }));
  }, [products, search, vegetarianOnly]);

  useEffect(() => {
    if (!products.length || !window.location.hash) return;
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' }), 80);
  }, [products]);

  function add(product: Product) {
    if ((items[product.id] || 0) >= 10) {
      setStatus('You can add up to 10 of each item.');
      setStatusError(true);
      return;
    }
    addItem(product.id);
    setStatus(`${product.name} added to your bag.`);
    setStatusError(false);
  }

  return (
    <div className="section-wrap page-content menu-page">
      <PageIntro eyebrow="FROM OUR KITCHEN" title="The menu">Comforting favorites, with the prices set by our kitchen menu.</PageIntro>
      <div className="menu-search-controls"><label htmlFor="menu-search">Search dishes</label><input id="menu-search" type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Name, ingredient, or category" /><label className="menu-vegetarian-filter"><input type="checkbox" checked={vegetarianOnly} onChange={(event) => setVegetarianOnly(event.currentTarget.checked)} /> Vegetarian only</label></div>
      <nav className="menu-jump-links" aria-label="Menu categories">
        {menuCategories.map((category) => <a key={category.id} href={`#${category.id}`}>{category.name}</a>)}
      </nav>
      {loading && <p className="quiet-message">Setting the table…</p>}
      <Status message={error || status} error={Boolean(error) || statusError} />
      {!loading && !error && <div className="menu-sections">
        {grouped.map((group, index) => <section className={`menu-section menu-section-${index + 1}`} id={group.id} key={group.id}>
          <div className="menu-section-heading"><span className="menu-section-number">0{index + 1} / 04</span><h2>{group.name}</h2><p>{group.description}</p></div>
          <Photo image={group.photo} className="menu-section-photo" />
          <div className="menu-items">
            {group.products.length ? group.products.map((product) => <article className="menu-item" key={product.id}>
              <div className="menu-item-copy"><h3>{product.name}</h3><p>{product.description}</p></div>
              <strong className="menu-item-price">{formatMoney(product.priceCents)}</strong>
              <button className="menu-item-add" type="button" onClick={() => add(product)} aria-label={`Add ${product.name} to your bag`}>Add <span aria-hidden="true">+</span></button>
            </article>) : <p className="menu-empty">{search || vegetarianOnly ? 'No dishes match these filters.' : 'More from this section soon.'}</p>}
          </div>
        </section>)}
      </div>}
      <p className="menu-footnote">Prices are shown in Indian rupees. The server uses current menu prices to calculate your order.</p>
    </div>
  );
}

export function CartPage() {
  const { products, loading, error } = useMenu();
  const { items, setQuantity, removeItem } = useCart();
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const cartLines = Object.entries(items).flatMap(([id, quantity]) => {
    const product = productById.get(id);
    return product ? [{ product, quantity }] : [];
  });
  const subtotal = cartLines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  const tax = Math.round(subtotal * TAX_RATE);

  return (
    <div className="section-wrap page-content cart-page">
      <PageIntro eyebrow="A LITTLE SOMETHING FOR LATER" title="Your bag" />
      {loading && <p className="quiet-message">Gathering your order…</p>}
      {error && <Status message={error} error />}
      {!loading && !error && cartLines.length === 0 && <div className="empty-state"><p>Your bag is waiting for something delicious.</p><Link className="button button-reserve" to="/menu">Browse the menu</Link></div>}
      {!loading && !error && cartLines.length > 0 && <div className="cart-layout">
        <div className="table-scroll"><table className="cart-table"><caption className="visually-hidden">Items in your bag</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Price</th><th scope="col">Line total</th><th scope="col"><span className="visually-hidden">Remove</span></th></tr></thead>
          <tbody>{cartLines.map(({ product, quantity }) => <tr key={product.id}>
            <td>{product.name}</td>
            <td><label className="visually-hidden" htmlFor={`quantity-${product.id}`}>Quantity of {product.name}</label><input id={`quantity-${product.id}`} type="number" min="1" max="10" step="1" value={quantity} onChange={(event) => setQuantity(product.id, Number(event.currentTarget.value))} /></td>
            <td>{formatMoney(product.priceCents)}</td><td>{formatMoney(product.priceCents * quantity)}</td>
            <td><button className="button-remove" type="button" aria-label={`Remove ${product.name}`} onClick={() => removeItem(product.id)}>Remove</button></td>
          </tr>)}</tbody>
        </table></div>
        <aside className="cart-summary" aria-label="Order estimate">
          <p><span>Subtotal</span><strong>{formatMoney(subtotal)}</strong></p><p><span>Estimated tax (8%)</span><strong>{formatMoney(tax)}</strong></p>
          <p className="summary-total"><span>Estimated total</span><strong>{formatMoney(subtotal + tax)}</strong></p>
          <p className="fine-print">Final totals are calculated at checkout.</p>
          <Link className="button button-reserve button-full" to="/checkout">Continue to checkout</Link>
        </aside>
      </div>}
    </div>
  );
}

export function CheckoutPage() {
  const { products, loading, error } = useMenu();
  const { items, clear } = useCart();
  const { user, ready: authReady } = useAuth();
  const [paymentConfig, setPaymentConfig] = useState<DeliveryPaymentConfig | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressMode, setAddressMode] = useState<'saved' | 'new'>('saved');
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressLoadError, setAddressLoadError] = useState('');
  const [paymentConfigLoading, setPaymentConfigLoading] = useState(true);
  const [paymentConfigError, setPaymentConfigError] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash_on_delivery');
  const onlinePaymentMethod: PaymentMethod = paymentConfig?.mode === 'demo' ? 'demo_online' : 'razorpay';
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<OrderResponse | null>(() => Object.values(items).some((quantity) => quantity > 0) ? null : readSavedOrder('juniper-table-last-delivery-order'));
  const [pendingPayment, setPendingPayment] = useState<OrderResponse | null>(() => readSavedOrder('juniper-table-pending-payment'));
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const lines = Object.entries(items).flatMap(([id, quantity]) => {
    const product = productById.get(id);
    return product ? [{ product, quantity }] : [];
  });
  const subtotal = lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  const deliveryFee = paymentConfig?.deliveryFeeCents || 0;
  const canSubmitAddress = addressMode === 'new' || addresses.some((address) => address.id === selectedAddressId);

  useEffect(() => {
    let active = true;
    api<DeliveryPaymentConfig>('/payments/config')
      .then((config) => { if (active) setPaymentConfig(config); })
      .catch((reason: unknown) => { if (active) setPaymentConfigError(reason instanceof Error ? reason.message : 'Payment options could not be loaded.'); })
      .finally(() => { if (active) setPaymentConfigLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!user || (user.role !== 'customer' && user.role !== 'admin')) {
      setAddresses([]); setSelectedAddressId(''); setAddressMode('new');
      return () => { active = false; };
    }
    setAddressesLoading(true);
    api<{ addresses: CustomerAddress[] }>('/addresses')
      .then((result) => {
        if (!active) return;
        setAddresses(result.addresses);
        setAddressLoadError('');
        const preferred = result.addresses.find((address) => address.isDefault) || result.addresses[0];
        if (preferred) { setSelectedAddressId(preferred.id); setAddressMode('saved'); }
        else { setSelectedAddressId(''); setAddressMode('new'); }
      })
      .catch((reason: unknown) => { if (active) { setAddressLoadError(reason instanceof Error ? reason.message : 'Saved addresses could not be loaded.'); setSelectedAddressId(''); setAddressMode('new'); } })
      .finally(() => { if (active) setAddressesLoading(false); });
    return () => { active = false; };
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!receipt?.order.trackingToken || ['delivered', 'completed', 'rejected', 'cancelled'].includes(receipt.order.status)) return;
    let active = true;
    let timer: number | undefined;
    const refreshStatus = async () => {
      try {
        const query = new URLSearchParams({ token: receipt.order.trackingToken });
        const current = await api<{ status: string; paymentStatus: string }>(`/orders/${encodeURIComponent(receipt.order.id)}/status?${query.toString()}`);
        if (!active) return;
        if (current.status !== receipt.order.status || current.paymentStatus !== receipt.order.paymentStatus) {
          const updated: OrderResponse = { ...receipt, order: { ...receipt.order, status: current.status, paymentStatus: current.paymentStatus } };
          saveOrder('juniper-table-last-delivery-order', updated);
          setReceipt(updated);
          return;
        }
      } catch { /* Keep the order screen available and retry a temporary network failure. */ }
      if (active) timer = window.setTimeout(() => { void refreshStatus(); }, 8000);
    };
    void refreshStatus();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [receipt]);

  async function finishOnlinePayment(order: OrderResponse) {
    const payment = order.payment;
    if (!payment || !paymentConfig?.onlinePaymentsEnabled) throw new Error('Online payments are not available. Choose cash on delivery or contact the restaurant.');
    if (payment.provider === 'demo') {
      setStatus('Completing demo checkout…'); setStatusError(false);
      const verification = await api<{ message: string; order: { status: string; paymentStatus: string } }>(`/orders/${encodeURIComponent(order.order.id)}/complete-demo-payment`, {
        method: 'POST',
        body: JSON.stringify({ token: payment.demoPaymentToken }),
      });
      const paidOrder: OrderResponse = {
        ...order,
        message: verification.message,
        order: { ...order.order, status: verification.order.status, paymentStatus: verification.order.paymentStatus },
      };
      saveOrder('juniper-table-last-delivery-order', paidOrder);
      saveOrder('juniper-table-pending-payment', null);
      setPendingPayment(null);
      clear();
      setReceipt(paidOrder);
      setStatus('');
      return;
    }
    if (payment.provider !== 'razorpay') throw new Error('This online payment method is unavailable.');
    await loadRazorpayCheckout();
    if (!window.Razorpay) throw new Error('Online checkout could not be loaded.');
    const paymentResult = await new Promise<RazorpayCheckoutResult>((resolve, reject) => {
      const checkout = new window.Razorpay!({
        key: payment.keyId,
        amount: payment.amount,
        currency: payment.currency,
        name: 'Foodie Table',
        description: 'Restaurant delivery order',
        order_id: payment.gatewayOrderId,
        prefill: {
          name: String(document.getElementById('order-name') && (document.getElementById('order-name') as HTMLInputElement).value || ''),
          email: String(document.getElementById('order-email') && (document.getElementById('order-email') as HTMLInputElement).value || ''),
          contact: String(document.getElementById('order-phone') && (document.getElementById('order-phone') as HTMLInputElement).value || ''),
        },
        theme: { color: '#702C2C' },
        handler: resolve,
        modal: { ondismiss: () => reject(new Error('Payment window closed before confirmation. Retry payment below or check with your bank before trying again.')) },
      });
      checkout.on('payment.failed', (result) => reject(new Error(result.error?.description || 'Payment did not succeed. You can retry the same order.')));
      checkout.open();
    });

    setStatus('Verifying the payment securely…'); setStatusError(false);
    const verification = await api<{ message: string; order: { status: string; paymentStatus: string } }>(`/orders/${encodeURIComponent(order.order.id)}/verify-payment`, {
      method: 'POST',
      body: JSON.stringify({
        razorpayOrderId: paymentResult.razorpay_order_id,
        razorpayPaymentId: paymentResult.razorpay_payment_id,
        razorpaySignature: paymentResult.razorpay_signature,
      }),
    });
    const paidOrder: OrderResponse = {
      ...order,
      message: verification.message,
      order: { ...order.order, status: verification.order.status, paymentStatus: verification.order.paymentStatus },
    };
    saveOrder('juniper-table-last-delivery-order', paidOrder);
    saveOrder('juniper-table-pending-payment', null);
    setPendingPayment(null);
    clear();
    setReceipt(paidOrder);
    setStatus('');
  }

  async function placeOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) {
      setStatus(addressMode === 'new' ? 'Complete the required delivery address fields before placing your order.' : 'Complete the required checkout fields before placing your order.');
      setStatusError(true);
      return;
    }
    if (lines.length === 0) return;
    const fields = new FormData(form);
    let address = addressMode === 'saved' ? addresses.find((candidate) => candidate.id === selectedAddressId) : undefined;
    if (addressMode === 'saved' && !address) {
      setStatus('Choose a saved address or add a new delivery address.'); setStatusError(true); return;
    }
    if (addressMode === 'new') {
      setStatus('Saving your delivery address…'); setStatusError(false);
      try {
        const created = await api<{ address: CustomerAddress }>('/addresses', {
          method: 'POST',
          body: JSON.stringify({
            label: String(fields.get('addressLabel') || 'Home'),
            recipientName: String(fields.get('recipientName') || fields.get('name') || ''),
            phone: String(fields.get('addressPhone') || ''),
            house: String(fields.get('house') || ''),
            locality: String(fields.get('locality') || ''),
            landmark: String(fields.get('landmark') || ''),
            city: String(fields.get('city') || ''),
            state: String(fields.get('state') || ''),
            pincode: String(fields.get('pincode') || ''),
            instructions: String(fields.get('deliveryInstructions') || ''),
            isDefault: addresses.length === 0,
          }),
        });
        address = created.address;
        setAddresses((current) => [created.address, ...current]);
        setSelectedAddressId(created.address.id);
        setAddressMode('saved');
      } catch (reason) {
        setStatus(reason instanceof Error ? reason.message : 'Your delivery address could not be saved.'); setStatusError(true); return;
      }
    }
    const body = {
      name: String(fields.get('name') || ''),
      email: String(fields.get('email') || ''),
      phone: address?.phone || '',
      addressId: address?.id,
      deliveryInstructions: address?.instructions || '',
      paymentMethod,
      items: Object.entries(items).map(([id, quantity]) => ({ id, quantity })),
    };
    setSending(true); setStatus(paymentMethod !== 'cash_on_delivery' ? 'Preparing online checkout…' : 'Sending your delivery order…'); setStatusError(false);
    try {
      const result = await api<OrderResponse>('/orders', { method: 'POST', body: JSON.stringify(body) });
      if (paymentMethod !== 'cash_on_delivery') {
        setPendingPayment(result); saveOrder('juniper-table-pending-payment', result);
        if (result.payment?.provider === 'demo') setStatus('Demo checkout is ready. No real payment will be charged.');
        else if (result.payment?.provider === 'razorpay') await finishOnlinePayment(result);
      } else {
        saveOrder('juniper-table-last-delivery-order', result);
        saveOrder('juniper-table-pending-payment', null);
        setReceipt(result); clear(); setStatus('');
      }
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'Your order could not be placed.'); setStatusError(true);
    } finally { setSending(false); }
  }

  async function retryPayment() {
    if (!pendingPayment) return;
    setSending(true); setStatus(pendingPayment.payment?.provider === 'demo' ? 'Completing demo checkout…' : 'Opening secure checkout…'); setStatusError(false);
    try { await finishOnlinePayment(pendingPayment); }
    catch (reason) {
      // The order was cancelled or removed, so it can no longer be paid; let the customer check out again.
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 409)) abandonPendingPayment();
      setStatus(reason instanceof Error ? reason.message : 'Payment could not be confirmed.'); setStatusError(true);
    }
    finally { setSending(false); }
  }

  function abandonPendingPayment() {
    saveOrder('juniper-table-pending-payment', null);
    setPendingPayment(null);
  }

  if (receipt) {
    const order = receipt.order;
    const stages = [
      { status: 'pending', label: 'Received' },
      { status: 'confirmed', label: 'Confirmed' },
      { status: 'preparing', label: 'Preparing' },
      { status: 'ready', label: 'Prepared' },
      { status: 'picked_up', label: 'Picked up' },
      { status: 'out_for_delivery', label: 'Out for delivery' },
      { status: 'delivered', label: 'Delivered' },
    ];
    const stageIndex = order.status === 'completed' ? stages.length - 1 : stages.findIndex((stage) => stage.status === order.status);
    const paymentCopy = order.paymentMethod === 'demo_online'
      ? order.paymentStatus === 'paid' ? 'Demo payment · no charge' : 'Demo payment pending · no charge'
      : order.paymentMethod === 'razorpay'
        ? order.paymentStatus === 'paid' ? 'Paid online' : 'Online payment pending'
        : 'Cash on delivery';
    return <div className="section-wrap page-content narrow-content delivery-receipt-page">
      <p className="eyebrow">FOODIE TABLE · DELIVERY</p>
      <h1>{order.status === 'cancelled' ? 'Order cancelled' : order.status === 'rejected' ? 'Order not accepted' : 'Your order is in.'}</h1>
      <p>{receipt.message} Order number: <strong>{order.id.slice(-8).toUpperCase()}</strong>.</p>
      <section className="delivery-tracking-panel" aria-live="polite">
        {order.status === 'cancelled' ? <p className="delivery-cancelled">This order was cancelled. Contact the restaurant if you need help.</p> : order.status === 'rejected' ? <p className="delivery-cancelled">The restaurant could not accept this order. Any online refund is shown in the payment status.</p> : order.status === 'awaiting_payment' ? <p className="delivery-pending-payment">Waiting for payment confirmation. The restaurant has not started preparing this order.</p> : <>
          <div className="delivery-tracking-heading"><span>DELIVERY STATUS</span><strong>{order.status.replaceAll('_', ' ')}</strong></div>
          <ol className="delivery-timeline">{stages.map((stage, index) => <li className={index <= stageIndex ? 'is-complete' : ''} key={stage.status}><span aria-hidden="true">{index < stageIndex ? '✓' : index === stageIndex ? '•' : ''}</span><small>{stage.label}</small></li>)}</ol>
        </>}
        <div className="delivery-receipt-meta"><p><span>Payment</span><strong>{paymentCopy}</strong></p><p><span>Order total</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></p></div>
      </section>
      <section className="order-summary delivery-order-summary"><h2>In your order</h2><ul>{order.items.map((item) => <li key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{formatMoney(item.priceCents * item.quantity, order.currency)}</strong></li>)}</ul>
        <p><span>Subtotal</span><strong>{formatMoney(order.subtotalCents, order.currency)}</strong></p><p><span>Estimated tax</span><strong>{formatMoney(order.taxCents, order.currency)}</strong></p>{order.deliveryFeeCents > 0 && <p><span>Delivery charge</span><strong>{formatMoney(order.deliveryFeeCents, order.currency)}</strong></p>}<p className="receipt-total"><span>Total</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></p>
      </section>
      <p className="fine-print">This page refreshes the order status while it is open. Delivery timing and availability are confirmed by the restaurant.</p>
      <div className="button-row">{user && <Link className="button button-reserve" to={`/account/orders/${encodeURIComponent(order.id)}`}>Track this order</Link>}<Link className="button button-outline-dark" to="/menu" onClick={() => saveOrder('juniper-table-last-delivery-order', null)}>Order more</Link><Link className="button button-outline-dark" to="/" onClick={() => saveOrder('juniper-table-last-delivery-order', null)}>Home</Link></div>
      {!user && <p className="fine-print checkout-tracking-note">This order is trackable here. Sign in before your next checkout to keep orders in your account history.</p>}
    </div>;
  }

  return (
    <div className="section-wrap page-content narrow-content checkout-page">
      <PageIntro eyebrow="DELIVERY · CHECKOUT" title="A good meal, on its way.">Add your delivery details, review the total, then choose cash on delivery or secure online payment.</PageIntro>
      <Status message={error} error={Boolean(error)} />
      {loading && <p className="quiet-message">Gathering your order…</p>}
      {!loading && !error && lines.length === 0 && !pendingPayment && <div className="empty-state"><p>Your bag is empty. Add something from the menu before checkout.</p><Link className="button button-reserve" to="/menu">Browse the menu</Link></div>}
      {pendingPayment && <section className="pending-payment-panel"><p className="eyebrow">PAYMENT NOT YET CONFIRMED</p><h2>{pendingPayment.payment?.provider === 'demo' ? 'Complete demo payment' : 'Finish your payment'}</h2><p>Order {pendingPayment.order.id.slice(-8).toUpperCase()} is waiting for online payment. It will not be sent to the kitchen until payment is confirmed.</p>{pendingPayment.payment?.provider === 'demo' && <p className="demo-payment-notice">Demo checkout only. Clicking below records a test payment; no money will be charged.</p>}<Status message={status} error={statusError} /><button className="button button-reserve" type="button" disabled={sending || !paymentConfig?.onlinePaymentsEnabled} onClick={() => void retryPayment()}>{sending ? 'Completing checkout…' : pendingPayment.payment?.provider === 'demo' ? 'Complete demo payment' : 'Retry online payment'}</button> <button className="button button-outline-dark" type="button" disabled={sending} onClick={abandonPendingPayment}>Start a new order</button>{pendingPayment.payment?.provider !== 'demo' && <p className="fine-print">If you completed payment but returned here, check your bank status before trying again.</p>}</section>}
      {!loading && !error && lines.length > 0 && !pendingPayment && <>
        <section className="order-summary"><h2>In your bag</h2><ul>{lines.map(({ product, quantity }) => <li key={product.id}><span>{product.name} × {quantity}</span><strong>{formatMoney(product.priceCents * quantity)}</strong></li>)}</ul>
          <p><span>Subtotal</span><strong>{formatMoney(subtotal)}</strong></p><p><span>Estimated tax (8%)</span><strong>{formatMoney(tax)}</strong></p>{deliveryFee > 0 && <p><span>Delivery charge</span><strong>{formatMoney(deliveryFee)}</strong></p>}<p className="summary-total"><span>Estimated total</span><strong>{formatMoney(subtotal + tax + deliveryFee)}</strong></p><p className="fine-print">The server calculates the final amount from current menu prices. No delivery charge has been configured unless one appears above.</p>
        </section>
        <aside className="checkout-account-note" aria-label="Order tracking in your account">
          <span className="eyebrow">ORDER TRACKING</span>
          {user
            ? <p>You are signed in as {user.email}. This order will appear in <Link to="/account/orders">My orders</Link> after checkout.</p>
            : <p><Link to="/account">Sign in with a customer account</Link> before checkout to keep this order in your order history. Orders are linked to the account signed in when they are placed.</p>}
        </aside>
        {!authReady ? <p className="quiet-message">Checking your account…</p> : !user || (user.role !== 'customer' && user.role !== 'admin') ? <section className="checkout-login-required"><p className="eyebrow">SAVE YOUR ORDER HISTORY</p><h2>Sign in with a customer account</h2><p>Delivery checkout is available to customer and administrator accounts. Sign in with an eligible account to continue.</p><Link className="button button-reserve" to="/account">Sign in</Link></section> : <form className="form-card" onSubmit={placeOrder}>
          <label htmlFor="order-name">Name</label><input id="order-name" name="name" autoComplete="name" maxLength={100} defaultValue={user.name} required />
          <label htmlFor="order-email">Email</label><input id="order-email" name="email" type="email" autoComplete="email" maxLength={254} defaultValue={user.email} required />
          <label htmlFor="checkout-address-choice">Delivery address</label>
          {addressesLoading ? <p className="quiet-message">Loading your saved addresses…</p> : addresses.length > 0 && <select id="checkout-address-choice" value={addressMode === 'new' ? '__new' : selectedAddressId} onChange={(event) => { if (event.currentTarget.value === '__new') setAddressMode('new'); else { setSelectedAddressId(event.currentTarget.value); setAddressMode('saved'); } }}>
            {addresses.map((address) => <option key={address.id} value={address.id}>{address.label}{address.isDefault ? ' · Default' : ''} — {address.formatted}</option>)}
            <option value="__new">Add a new address</option>
          </select>}
          {addressLoadError && <p className="notice is-error" role="alert">{addressLoadError} You can still enter a delivery address below.</p>}
          {!addressesLoading && addresses.length === 0 && <div className="checkout-address-empty" aria-live="polite"><p>{addressLoadError ? 'Enter your delivery address below to continue.' : 'No saved addresses yet. Add one now; it will be saved to your account.'}</p>{addressMode !== 'new' && <button className="button button-outline-dark button-small" type="button" onClick={() => setAddressMode('new')}>Add a delivery address</button>}</div>}
          {addressMode === 'saved' && !addresses.some((address) => address.id === selectedAddressId) && <div className="checkout-address-empty"><p>Select one of your saved addresses, or add a new delivery address.</p><button className="button button-outline-dark button-small" type="button" onClick={() => setAddressMode('new')}>Add a delivery address</button></div>}
          {addressMode === 'saved' && selectedAddressId && addresses.find((address) => address.id === selectedAddressId) && <div className="checkout-address-summary"><strong>{addresses.find((address) => address.id === selectedAddressId)?.recipientName}</strong><p>{addresses.find((address) => address.id === selectedAddressId)?.formatted}</p><p>{addresses.find((address) => address.id === selectedAddressId)?.phone}</p></div>}
          {addressMode === 'new' && <div className="checkout-address-fields">
            <p className="fine-print">This address will be saved to your account for future orders.</p>
            <label htmlFor="address-label">Save as</label><select id="address-label" name="addressLabel"><option>Home</option><option>Work</option><option>Other</option></select>
            <label htmlFor="recipient-name">Recipient name</label><input id="recipient-name" name="recipientName" autoComplete="name" maxLength={100} defaultValue={user.name} required />
            <label htmlFor="address-phone">Mobile number</label><input id="address-phone" name="addressPhone" type="tel" autoComplete="tel" maxLength={25} pattern="(?:\+91[ -]?)?[6-9][0-9]{9}" title="Enter a 10-digit Indian mobile number." required />
            <label htmlFor="address-house">House or flat number</label><input id="address-house" name="house" autoComplete="address-line1" maxLength={120} required />
            <label htmlFor="address-locality">Street or locality</label><input id="address-locality" name="locality" autoComplete="address-line2" maxLength={160} required />
            <label htmlFor="address-landmark">Landmark <span className="optional-label">Optional</span></label><input id="address-landmark" name="landmark" maxLength={160} />
            <div className="form-row"><div><label htmlFor="address-city">City</label><input id="address-city" name="city" autoComplete="address-level2" maxLength={100} required /></div><div><label htmlFor="address-state">State</label><input id="address-state" name="state" autoComplete="address-level1" maxLength={100} required /></div></div>
            <label htmlFor="address-pincode">PIN code</label><input id="address-pincode" name="pincode" inputMode="numeric" autoComplete="postal-code" pattern="[0-9]{6}" maxLength={6} required />
            <label htmlFor="delivery-instructions">Delivery instructions <span className="optional-label">Optional</span></label><textarea id="delivery-instructions" name="deliveryInstructions" placeholder="Gate, floor, or other helpful directions" maxLength={500} rows={2} />
          </div>}
          <fieldset className="payment-options"><legend>How would you like to pay?</legend>
            <label className={paymentMethod === 'cash_on_delivery' ? 'is-selected' : ''}><input type="radio" name="paymentMethod" value="cash_on_delivery" checked={paymentMethod === 'cash_on_delivery'} onChange={() => setPaymentMethod('cash_on_delivery')} /><span><strong>Cash on delivery</strong><small>Pay the restaurant when your order arrives.</small></span></label>
            <label className={`online-payment-option${paymentMethod === onlinePaymentMethod ? ' is-selected' : ''}${!paymentConfig?.onlinePaymentsEnabled ? ' is-disabled' : ''}`}><input type="radio" name="paymentMethod" value={onlinePaymentMethod} checked={paymentMethod === onlinePaymentMethod} disabled={paymentConfigLoading || !paymentConfig?.onlinePaymentsEnabled} onChange={() => setPaymentMethod(onlinePaymentMethod)} /><span><strong>Pay online</strong><small>{paymentConfigLoading ? 'Checking online payment availability…' : paymentConfig?.mode === 'demo' ? `Demo checkout · no real charge · ${paymentConfig.currency}` : paymentConfig?.onlinePaymentsEnabled ? `Secure checkout via Razorpay · ${paymentConfig.currency}` : 'Online payment is not configured by the restaurant yet.'}</small></span></label>
          </fieldset>
          {paymentConfigError && <p className="fine-print">{paymentConfigError} Cash on delivery is still available.</p>}
          <p className="fine-print">The restaurant confirms delivery availability and timing after receiving your order. Payment details are handled by the selected payment method.</p>
          <Status message={status} error={statusError} />
          <button className="button button-reserve button-full" type="submit" disabled={sending || paymentConfigLoading || addressesLoading || !canSubmitAddress}>{sending ? 'Submitting…' : paymentMethod === 'demo_online' ? 'Continue to demo payment' : paymentMethod === 'razorpay' ? 'Continue to secure payment' : 'Place delivery order'}</button>
        </form>}
      </>}
    </div>
  );
}

export function ReservationPage() {
  const { user } = useAuth();
  const { products, loading: menuLoading, error: menuError } = useMenu();
  const [restaurants, setRestaurants] = useState<RestaurantOption[]>([]);
  const [restaurantId, setRestaurantId] = useState('');
  const [restaurantsLoading, setRestaurantsLoading] = useState(true);
  const [restaurantError, setRestaurantError] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [guests, setGuests] = useState('2');
  const [tables, setTables] = useState<TableOption[] | null>(null);
  const [selectedTableId, setSelectedTableId] = useState('');
  const [orderItems, setOrderItems] = useState<Record<string, number>>({});
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [bookingStatus, setBookingStatus] = useState('');
  const [bookingStatusError, setBookingStatusError] = useState(false);
  const [confirmation, setConfirmation] = useState<ReservationConfirmation | null>(loadSavedReservation);

  useEffect(() => {
    let active = true;
    void api<{ restaurants: RestaurantOption[] }>('/restaurants').then((result) => {
      if (!active) return;
      setRestaurants(result.restaurants);
      setRestaurantId((current) => current || result.restaurants[0]?.id || '');
      setRestaurantError('');
    }).catch((reason) => {
      if (active) setRestaurantError(reason instanceof Error ? reason.message : 'Restaurants could not be loaded.');
    }).finally(() => { if (active) setRestaurantsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!confirmation?.trackingToken || ['rejected', 'completed', 'cancelled'].includes(confirmation.reservation.status)) return;
    let active = true;
    let timer: number | undefined;
    const checkStatus = async () => {
      try {
        const query = new URLSearchParams({ token: confirmation.trackingToken });
        const current = await api<{ status: ReservationConfirmation['reservation']['status']; tableId: string; currency: string }>(
          `/reservations/${encodeURIComponent(confirmation.reservation.id)}/status?${query.toString()}`,
        );
        if (!active) return;
        if (current.status !== confirmation.reservation.status || current.tableId !== confirmation.reservation.tableId || current.currency !== confirmation.reservation.currency) {
          const updated = { ...confirmation, reservation: { ...confirmation.reservation, status: current.status, tableId: current.tableId, currency: current.currency } };
          saveReservation(updated);
          setConfirmation(updated);
          return;
        }
      } catch { /* A later status check can recover from a temporary network error. */ }
      if (active) timer = window.setTimeout(() => { void checkStatus(); }, 8000);
    };
    void checkStatus();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [confirmation]);

  const selectedTable = tables?.find((table) => table.id === selectedTableId);
  const selectedRestaurant = restaurants.find((restaurant) => restaurant.id === restaurantId);
  const preorderTotal = products.reduce((sum, product) => sum + product.priceCents * (orderItems[product.id] || 0), 0);
  const sectionNames = ['A', 'B', 'C'] as const;

  async function findTables(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setSearching(true); setStatus(''); setStatusError(false); setSelectedTableId(''); setOrderItems({});
    try {
      if (!selectedRestaurant) {
        setStatus('Choose a restaurant before checking table availability.'); setStatusError(true); setSearching(false); return;
      }
      const query = new URLSearchParams({ restaurantId: selectedRestaurant.id, date, time, guests });
      const result = await api<{ tables: TableOption[] }>(`/reservations/availability?${query.toString()}`);
      setTables(result.tables);
      if (!result.tables.some((table) => table.available)) {
        setStatus('No suitable tables are available for that time. Try a different time or party size.');
        setStatusError(true);
      }
    } catch (reason) {
      setTables(null);
      setStatus(reason instanceof Error ? reason.message : 'Table availability could not be loaded.'); setStatusError(true);
    } finally { setSearching(false); }
  }

  function changeSlot(change: () => void) {
    change();
    setTables(null); setSelectedTableId(''); setOrderItems({}); setStatus(''); setStatusError(false);
    setBookingStatus(''); setBookingStatusError(false);
  }

  function adjustItem(product: Product, amount: number) {
    setOrderItems((current) => {
      const nextQuantity = Math.max(0, Math.min(10, (current[product.id] || 0) + amount));
      const next = { ...current };
      if (nextQuantity === 0) delete next[product.id];
      else next[product.id] = nextQuantity;
      return next;
    });
  }

  async function bookTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!selectedTable?.available) {
      setStatus('Choose an available table before continuing.'); setStatusError(true); return;
    }
    const fields = new FormData(form);
    const body = {
      restaurantId: selectedRestaurant?.id,
      name: String(fields.get('name') || ''),
      email: String(fields.get('email') || ''),
      phone: String(fields.get('phone') || ''),
      date,
      time,
      guests: Number(guests),
      tableId: selectedTable.id,
      specialRequests: String(fields.get('specialRequests') || ''),
      items: Object.entries(orderItems).map(([id, quantity]) => ({ id, quantity })),
    };
    setSending(true); setBookingStatus('Saving your table request…'); setBookingStatusError(false);
    try {
      const result = await api<Omit<ReservationConfirmation, 'date' | 'time' | 'guests'>>('/reservations', { method: 'POST', body: JSON.stringify(body) });
      const saved = { ...result, restaurantName: result.restaurantName || selectedRestaurant?.name || 'Foodie Table', date, time, guests: Number(guests) };
      saveReservation(saved);
      setConfirmation(saved);
      setTables((current) => current?.map((table) => table.id === selectedTable.id ? { ...table, available: false } : table) || null);
      setBookingStatus('');
    } catch (reason) {
      setBookingStatus(reason instanceof Error ? reason.message : 'Your table request could not be saved.'); setBookingStatusError(true);
    } finally { setSending(false); }
  }

  if (confirmation) {
    const table = confirmation.reservation;
    const approved = table.status === 'confirmed' || table.status === 'seated' || table.status === 'completed';
    const statusMessage = table.status === 'pending'
      ? 'Request received · waiting for restaurant approval'
      : table.status === 'confirmed'
        ? `Approved · table ${table.tableId} is reserved for you`
        : table.status === 'rejected'
          ? 'The restaurant could not accept this request'
        : table.status === 'seated'
          ? `You’re checked in at table ${table.tableId}`
          : table.status === 'completed'
            ? 'Your reservation is complete'
            : 'This request was cancelled · please contact the restaurant';
    const confirmationCopy = table.status === 'confirmed'
      ? 'The restaurant approved your table request.'
      : table.status === 'seated'
        ? 'The restaurant has marked you as seated.'
        : table.status === 'completed'
          ? 'The restaurant marked this reservation complete.'
        : table.status === 'rejected'
          ? 'The restaurant could not accept your table request. Please choose another time.'
          : table.status === 'cancelled'
            ? 'This table request was cancelled.'
            : confirmation.message;
    return <div className="section-wrap page-content reservation-confirmation-page">
      <section className="reservation-confirmation">
        <p className="eyebrow">{table.status === 'confirmed' ? 'TABLE CONFIRMED' : table.status === 'rejected' ? 'REQUEST NOT ACCEPTED' : 'YOUR REQUEST IS SAVED'}</p>
        <h1>A place at<br /><em>the table.</em></h1>
        <p>{confirmationCopy}</p>
        <div className={`reservation-live-status${approved ? ' is-approved' : table.status === 'cancelled' ? ' is-cancelled' : ''}`} role="status" aria-live="polite">
          <span aria-hidden="true">{approved ? '✓' : table.status === 'cancelled' ? '×' : '…'}</span>
          <strong>{statusMessage}</strong>
        </div>
        <dl className="reservation-receipt">
          <div><dt>Restaurant</dt><dd>{confirmation.restaurantName || 'Foodie Table'}</dd></div>
          <div><dt>Table</dt><dd>{table.tableId} · Section {table.section} · {table.seats} seats</dd></div>
          <div><dt>Date & time</dt><dd>{confirmation.date} at {confirmation.time}</dd></div>
          <div><dt>Party</dt><dd>{confirmation.guests} {confirmation.guests === 1 ? 'guest' : 'guests'}</dd></div>
          <div><dt>Dishes saved</dt><dd>{table.items?.length ? table.items.map((item) => `${item.quantity} × ${item.name}`).join(', ') : 'No pre-order; choose from the menu when you arrive.'}</dd></div>
          {table.items?.length > 0 && <div><dt>Pre-order estimate</dt><dd>{formatMoney(table.preorderTotalCents, table.currency)} · payable at the restaurant</dd></div>}
        </dl>
        <p className="fine-print">Request reference {confirmation.reservation.id.slice(-8).toUpperCase()}. This page checks for status changes while it is open.</p>
        <div className="button-row"><Link className="button button-reserve" to="/menu">Back to the menu</Link><button className="button button-outline-dark" type="button" onClick={() => { sessionStorage.removeItem('juniper-table-reservation-status'); setConfirmation(null); }}>Make another reservation</button></div>
      </section>
      <Photo image={photography.room} className="confirmation-photo" />
    </div>;
  }

  return (
    <div className="reservation-booking-page section-wrap page-content">
      <header className="reservation-booking-intro">
        <PageIntro eyebrow="SAVE YOUR SEAT" title={`Book a table at ${selectedRestaurant?.name || 'a restaurant'}.`}>Choose the restaurant first, then pick a time, find a table that fits, and add dishes for your visit if you like.</PageIntro>
        <p className="reservation-flow-note">Your selected restaurant and table request will appear in the booking summary before you submit.</p>
      </header>

      <section className="booking-step restaurant-choice-step" aria-labelledby="reservation-step-one">
        <div className="booking-step-heading"><span>01</span><div><p className="eyebrow">WHERE ARE YOU DINING?</p><h2 id="reservation-step-one">Choose a restaurant</h2></div></div>
        <div className="form-card restaurant-choice-card">
          <label htmlFor="reservation-restaurant">Restaurant</label>
          <select id="reservation-restaurant" value={restaurantId} disabled={restaurantsLoading || restaurants.length === 0} onChange={(event) => {
            setRestaurantId(event.currentTarget.value); setTables(null); setSelectedTableId(''); setOrderItems({}); setStatus(''); setStatusError(false); setBookingStatus(''); setBookingStatusError(false);
          }}>
            {restaurantsLoading && <option value="">Loading restaurants…</option>}
            {restaurants.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>)}
          </select>
          {selectedRestaurant && <p className="restaurant-choice-selected"><span>Booking at</span><strong>{selectedRestaurant.name}</strong></p>}
          {restaurantError && <p className="notice is-error" role="alert">{restaurantError}</p>}
        </div>
      </section>

      <section className="booking-step booking-step-search" aria-labelledby="reservation-step-two">
        <div className="booking-step-heading"><span>02</span><div><p className="eyebrow">WHEN ARE YOU COMING?</p><h2 id="reservation-step-two">Find a table</h2></div></div>
        <form className="form-card reservation-search-form" onSubmit={findTables}>
          <div><label htmlFor="reservation-date">Date</label><input id="reservation-date" name="date" type="date" min={localDateValue()} value={date} onChange={(event) => changeSlot(() => setDate(event.currentTarget.value))} required /></div>
          <div><label htmlFor="reservation-time">Time</label><input id="reservation-time" name="time" type="time" step={900} value={time} onChange={(event) => changeSlot(() => setTime(event.currentTarget.value))} required /></div>
          <div><label htmlFor="reservation-guests">Party size</label><select id="reservation-guests" name="guests" value={guests} onChange={(event) => changeSlot(() => setGuests(event.currentTarget.value))}>{[1, 2, 3, 4, 5, 6].map((number) => <option key={number} value={number}>{number} {number === 1 ? 'guest' : 'guests'}</option>)}</select></div>
          <button className="button button-reserve" type="submit" disabled={searching || restaurantsLoading || !selectedRestaurant}>{searching ? 'Checking tables…' : `See tables at ${selectedRestaurant?.name || 'the restaurant'}`}</button>
        </form>
        <Status message={status} error={statusError} />
      </section>

      {tables !== null && <section className="booking-step floor-plan-step" aria-labelledby="reservation-step-three">
        <div className="booking-step-heading"><span>03</span><div><p className="eyebrow">YOUR TABLE MAP</p><h2 id="reservation-step-three">Choose a table</h2></div></div>
        <p className="floor-plan-disclaimer">{selectedRestaurant?.name || 'This restaurant'} · illustrative floor plan — positions and capacities are placeholders until the venue’s real layout is confirmed.</p>
        {tables.length === 0 ? <p className="empty-table-message">No sample tables fit this party size. Try a smaller party.</p> : <>
          <div className="floor-plan" aria-label={`${selectedRestaurant?.name || 'Restaurant'} illustrative floor plan`}>
            <div className="floor-plan-header"><span>{selectedRestaurant?.name || 'Restaurant'} · dining room</span><span>Entry side</span></div>
            <div className="floor-plan-sections">
              {sectionNames.map((section) => {
                const sectionTables = tables.filter((table) => table.section === section);
                if (!sectionTables.length) return null;
                return <section className={`floor-section floor-section-${section.toLowerCase()}`} key={section} aria-label={`Section ${section}`}>
                  <h3>Section {section}</h3>
                  <div className="floor-table-grid">
                    {sectionTables.map((table) => <button
                      key={table.id}
                      type="button"
                      className={`floor-table${table.available ? ' is-available' : ' is-unavailable'}${selectedTableId === table.id ? ' is-selected' : ''}`}
                      aria-pressed={selectedTableId === table.id}
                      aria-label={`Table ${table.id.slice(1)}, ${table.seats} seats, ${table.available ? 'available' : 'unavailable'}`}
                      disabled={!table.available}
              onClick={() => { setSelectedTableId(table.id); setOrderItems({}); setStatus(''); setStatusError(false); setBookingStatus(''); setBookingStatusError(false); }}
                    >
                      <span className="floor-table-number">{table.id.slice(1)}</span>
                      <span className="floor-table-capacity">{table.seats} seats</span>
                      <span className="floor-table-state">{table.available ? selectedTableId === table.id ? 'Selected' : 'Available' : 'Taken'}</span>
                    </button>)}
                  </div>
                </section>;
              })}
            </div>
            <div className="floor-aisle"><span>Walkway</span></div>
          </div>
          <div className="floor-plan-legend" aria-label="Table status legend"><span><i className="legend-available" />Available</span><span><i className="legend-selected" />Selected</span><span><i className="legend-taken" />Unavailable</span></div>
        </>}
      </section>}

      {selectedTable?.available && <section className="booking-step preorder-step" aria-labelledby="reservation-step-four">
        <div className="booking-step-heading"><span>04</span><div><p className="eyebrow">OPTIONAL PRE-ORDER</p><h2 id="reservation-step-four">Choose dishes for the table</h2></div></div>
        <p className="preorder-intro">Add dishes to your request now, or leave the list empty and choose from the menu when you arrive. Payment is handled at the restaurant.</p>
        {menuLoading && <p className="quiet-message">Loading the menu…</p>}
        {menuError && <Status message={menuError} error />}
        {!menuLoading && !menuError && <div className="preorder-list">
          {products.map((product) => <article className="preorder-item" key={product.id}>
            <div><span className="item-category">{product.category}</span><h3>{product.name}</h3><p>{product.description}</p></div>
            <strong>{formatMoney(product.priceCents)}</strong>
            <div className="quantity-stepper" aria-label={`${product.name} quantity`}>
              <button type="button" aria-label={`Remove one ${product.name}`} disabled={!orderItems[product.id]} onClick={() => adjustItem(product, -1)}>−</button>
              <span aria-live="polite">{orderItems[product.id] || 0}</span>
              <button type="button" aria-label={`Add one ${product.name}`} disabled={(orderItems[product.id] || 0) >= 10} onClick={() => adjustItem(product, 1)}>+</button>
            </div>
          </article>)}
        </div>}
        {preorderTotal > 0 && <p className="preorder-total"><span>Pre-order estimate</span><strong>{formatMoney(preorderTotal)}</strong></p>}
      </section>}

      {selectedTable?.available && <section className="booking-step guest-step" aria-labelledby="reservation-step-five">
        <div className="booking-step-heading"><span>05</span><div><p className="eyebrow">MAKE IT YOURS</p><h2 id="reservation-step-five">Your details</h2></div></div>
        <form className="form-card guest-form" onSubmit={bookTable}>
          <label htmlFor="reservation-name">Name</label><input id="reservation-name" name="name" autoComplete="name" maxLength={100} defaultValue={user?.role === 'customer' ? user.name : ''} required />
          <div className="form-row"><div><label htmlFor="reservation-email">Email</label><input id="reservation-email" name="email" type="email" autoComplete="email" maxLength={254} defaultValue={user?.role === 'customer' ? user.email : ''} required /></div>
            <div><label htmlFor="reservation-phone">Phone</label><input id="reservation-phone" name="phone" type="tel" autoComplete="tel" maxLength={25} pattern="(?:\+91[ -]?)?[6-9][0-9]{9}" required /></div></div>
          <label htmlFor="reservation-special-requests">Special requests <span className="optional-label">Optional</span></label><textarea id="reservation-special-requests" name="specialRequests" maxLength={500} rows={2} placeholder="Accessibility or seating preferences" />
          <div className="booking-summary">
            <p><span>Restaurant</span><strong>{selectedRestaurant?.name || 'Choose a restaurant'}</strong></p>
            <p><span>Your table</span><strong>{selectedTable.id} · Section {selectedTable.section}</strong></p>
            <p><span>Your visit</span><strong>{date} · {time} · {guests} {Number(guests) === 1 ? 'guest' : 'guests'}</strong></p>
            <p><span>Dishes selected</span><strong>{Object.values(orderItems).reduce((sum, quantity) => sum + quantity, 0) || 'Order at the table'}</strong></p>
            {preorderTotal > 0 && <p><span>Pre-order estimate</span><strong>{formatMoney(preorderTotal)}</strong></p>}
          </div>
          <Status message={bookingStatus} error={bookingStatusError} />
          <button className="button button-reserve button-full" type="submit" disabled={sending || menuLoading}>{sending ? 'Saving your request…' : 'Request this table'}</button>
          <p className="fine-print">Your table and any selected dishes are saved with the request. The restaurant will confirm your visit separately.</p>
        </form>
      </section>}
    </div>
  );
}

export function ContactPage() {
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [sending, setSending] = useState(false);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const body = Object.fromEntries(fields.entries());
    setSending(true); setStatus('Sending your message…'); setStatusError(false);
    try {
      const result = await api<{ message: string }>('/contact', { method: 'POST', body: JSON.stringify(body) });
      setStatus(result.message); form.reset();
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'Your message could not be sent.'); setStatusError(true);
    } finally { setSending(false); }
  }

  return (
    <div className="contact-page section-wrap page-content">
      <div className="contact-copy">
        <PageIntro eyebrow="SAY HELLO" title="We’d love to hear from you.">Have a question about the menu or your request? Leave us a note and we’ll be in touch.</PageIntro>
        <div className="contact-details">
          <div><span className="detail-label">Find us</span><p>Address to be confirmed</p></div>
          <div><span className="detail-label">Opening hours</span><p>Hours to be confirmed</p></div>
          <div><span className="detail-label">Call</span><p>Phone number to be confirmed</p></div>
        </div>
        <p className="photo-disclosure">Location and contact details will be added once confirmed. A map is not shown yet.</p>
      </div>
      <div className="contact-form-wrap">
        <Status message={status} error={statusError} />
        <form className="form-card" onSubmit={sendMessage}>
          <label htmlFor="contact-name">Name</label><input id="contact-name" name="name" autoComplete="name" maxLength={100} required />
          <label htmlFor="contact-email">Email</label><input id="contact-email" name="email" type="email" autoComplete="email" maxLength={254} required />
          <label htmlFor="contact-message">Message</label><textarea id="contact-message" name="message" maxLength={2000} minLength={3} rows={6} required />
          <button className="button button-reserve button-full" type="submit" disabled={sending}>{sending ? 'Sending…' : 'Send a note'}</button>
        </form>
      </div>
    </div>
  );
}

interface CustomerOrder {
  id: string;
  customerName?: string;
  email?: string;
  address: string;
  deliveryInstructions: string;
  paymentMethod: string;
  paymentStatus: string;
  items: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: string;
  status: string;
  statusHistory?: Array<{ status: string; changedAt: string }>;
  createdAt: string;
}

function mergeOrderHistory(current: CustomerOrder[], incoming: CustomerOrder[]): CustomerOrder[] {
  const byId = new Map(current.map((order) => [order.id, order]));
  for (const order of incoming) byId.set(order.id, { ...byId.get(order.id), ...order });
  return [...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_payment: 'Payment pending',
    pending: 'Received',
    confirmed: 'Confirmed',
    rejected: 'Rejected',
    preparing: 'Preparing',
    ready: 'Prepared',
    picked_up: 'Picked up',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    completed: 'Delivered',
    cancelled: 'Cancelled',
  };
  return labels[status] || status.replaceAll('_', ' ').replace(/^\w/, (first) => first.toUpperCase());
}

function orderDateLabel(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function orderPaymentLabel(order: CustomerOrder): string {
  if (order.paymentMethod === 'demo_online') return 'Demo online payment · no charge';
  if (order.paymentMethod === 'razorpay') return 'Online payment';
  return 'Cash on delivery';
}

export function OrderHistoryPage() {
  const { user, ready } = useAuth();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savingId, setSavingId] = useState('');

  useEffect(() => {
    if (!ready) return;
    if (!user || (user.role !== 'customer' && user.role !== 'admin')) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError(''); setOrders([]);
    const endpoint = user.role === 'admin' ? '/admin/dashboard' : '/account/orders';
    api<{ orders: CustomerOrder[] }>(endpoint)
      .then((result) => { if (active) setOrders((current) => mergeOrderHistory(current, result.orders)); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Your orders could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ready, user?.id, user?.role]);

  async function cancelOrder(orderId: string) {
    setSavingId(orderId); setNotice(''); setError('');
    try {
      const result = await api<{ message: string; status: string; paymentStatus: string }>(`/account/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
      setNotice(result.message);
      setOrders((current) => current.map((order) => order.id === orderId ? { ...order, status: result.status, paymentStatus: result.paymentStatus } : order));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This order could not be cancelled.'); }
    finally { setSavingId(''); }
  }

  useEffect(() => {
    if (!ready || !user || (user.role !== 'customer' && user.role !== 'admin')) return;
    let active = true;
    const endpoint = user.role === 'admin' ? '/admin/dashboard' : '/account/orders';
    const timer = window.setInterval(() => {
      api<{ orders: CustomerOrder[] }>(endpoint)
        .then((result) => { if (active) setOrders((current) => mergeOrderHistory(current, result.orders)); })
        .catch(() => undefined);
    }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ready, user?.id, user?.role]);

  return <div className="section-wrap page-content customer-orders-page">
    <PageIntro eyebrow="YOUR FOODIE TABLE" title={user?.role === 'admin' ? 'Customer orders' : 'Track your orders'}>{user?.role === 'admin' ? 'Recent delivery orders from customers. This list refreshes automatically.' : 'Follow each order from the kitchen to your door. Statuses refresh automatically while this page is open.'}</PageIntro>
    {notice && <Status message={notice} />}
    {!ready || loading ? <p className="quiet-message">Gathering your order history…</p> : !user ? <section className="customer-orders-empty"><h2>Sign in to see your orders</h2><p>Orders placed while signed in are saved to your customer account.</p><Link className="button button-reserve" to="/account">Sign in</Link></section> : user.role !== 'customer' && user.role !== 'admin' ? <section className="customer-orders-empty"><h2>Customer order history</h2><p>Sign in with a customer or administrator account to view orders.</p><Link className="button button-reserve" to="/account">Sign in</Link></section> : error ? <Status message={error} error /> : orders.length === 0 ? <section className="customer-orders-empty"><h2>No orders yet</h2><p>{user.role === 'admin' ? 'Customer orders will appear here as soon as they are submitted.' : 'Your delivery orders will appear here when you place them while signed in.'}</p><Link className="button button-reserve" to={user.role === 'admin' ? '/admin' : '/menu'}>{user.role === 'admin' ? 'Open admin desk' : 'Explore the menu'}</Link></section> : <div className="customer-order-list">
      {orders.map((order) => <article className="customer-order-card" key={order.id}>
        <div className="customer-order-card-top"><div><p className="eyebrow">ORDER · {order.id.slice(-8).toUpperCase()}</p><h2>{orderDateLabel(order.createdAt)}</h2>{user.role === 'admin' && order.customerName && <p>Customer: {order.customerName}{order.email ? ` · ${order.email}` : ''}</p>}<p>{order.items.map((item) => `${item.quantity} × ${item.name}`).join(' · ')}</p></div><span className={`order-status-badge status-${order.status}`}>{orderStatusLabel(order.status)}</span></div>
        <div className="customer-order-card-bottom"><p><span>{orderPaymentLabel(order)}</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></p>{user.role === 'admin' ? <Link className="button button-outline-dark customer-track-link" to="/admin">Manage orders <span aria-hidden="true">↗</span></Link> : <Link className="button button-outline-dark customer-track-link" to={`/account/orders/${encodeURIComponent(order.id)}`}>Track this order <span aria-hidden="true">↗</span></Link>}</div>
        {user.role === 'customer' && ['pending', 'awaiting_payment'].includes(order.status) && <button className="button button-outline-dark" type="button" disabled={savingId === order.id} onClick={() => void cancelOrder(order.id)}>{savingId === order.id ? 'Cancelling…' : 'Cancel order'}</button>}
      </article>)}
    </div>}
  </div>;
}

interface CustomerReservation {
  id: string;
  restaurantName?: string;
  date: string;
  time: string;
  guests: number;
  tableId: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'seated' | 'completed' | 'cancelled';
  items: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
  preorderTotalCents: number;
  currency: string;
  specialRequests: string;
  statusHistory: Array<{ status: string; changedAt: string }>;
  createdAt: string;
}

function reservationDateLabel(date: string, time: string): string {
  const value = new Date(`${date}T${time}:00+05:30`);
  return Number.isNaN(value.getTime()) ? `${date} · ${time}` : new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(value);
}

export function ReservationHistoryPage() {
  const { user, ready } = useAuth();
  const [reservations, setReservations] = useState<CustomerReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [notice, setNotice] = useState('');

  async function loadReservations() {
    setLoading(true); setError('');
    try { setReservations((await api<{ reservations: CustomerReservation[] }>('/account/reservations')).reservations); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Your reservations could not be loaded.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!ready) return;
    if (!user || user.role !== 'customer') { setLoading(false); return; }
    void loadReservations();
  }, [ready, user?.id, user?.role]);

  async function cancelReservation(id: string) {
    setSavingId(id); setNotice(''); setError('');
    try {
      const result = await api<{ message: string }>(`/account/reservations/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      setNotice(result.message); await loadReservations();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This reservation could not be cancelled.'); }
    finally { setSavingId(''); }
  }

  if (!ready || loading) return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="My reservations" /><p className="quiet-message">Gathering your reservation history…</p></div>;
  if (!user) return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Sign in to see reservations">Sign in to view bookings saved to your customer account.</PageIntro><Link className="button button-reserve" to="/account">Sign in</Link></div>;
  if (user.role !== 'customer') return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Customer reservations">Sign in with a customer account to view saved table reservations.</PageIntro><Link className="button button-reserve" to="/account">Customer sign in</Link></div>;

  const upcoming = reservations.filter((reservation) => ['pending', 'confirmed'].includes(reservation.status));
  const past = reservations.filter((reservation) => !['pending', 'confirmed'].includes(reservation.status));
  const reservationCard = (reservation: CustomerReservation) => <article className="customer-order-card reservation-history-card" key={reservation.id}>
    <div className="customer-order-card-top"><div><p className="eyebrow">TABLE REQUEST · {reservation.id.slice(-8).toUpperCase()}</p><h2>{reservationDateLabel(reservation.date, reservation.time)}</h2>{reservation.restaurantName && <p>{reservation.restaurantName}</p>}<p>{reservation.guests} {reservation.guests === 1 ? 'guest' : 'guests'} · {reservation.tableId}</p>{reservation.items.length > 0 && <p>{reservation.items.map((item) => `${item.quantity} × ${item.name}`).join(' · ')}</p>}{reservation.specialRequests && <p className="fine-print">Request: {reservation.specialRequests}</p>}</div><span className={`order-status-badge status-${reservation.status}`}>{reservation.status.replaceAll('_', ' ').replace(/^\w/, (first) => first.toUpperCase())}</span></div>
    <div className="customer-order-card-bottom"><p><span>{reservation.items.length ? 'Dine-in pre-order estimate' : 'No food pre-order'}</span><strong>{reservation.items.length ? formatMoney(reservation.preorderTotalCents, reservation.currency) : '—'}</strong></p>{['pending', 'confirmed'].includes(reservation.status) && <button className="button button-outline-dark" type="button" disabled={savingId === reservation.id} onClick={() => void cancelReservation(reservation.id)}>{savingId === reservation.id ? 'Cancelling…' : 'Cancel reservation'}</button>}</div>
  </article>;

  return <div className="section-wrap page-content customer-orders-page reservation-history-page">
    <PageIntro eyebrow="YOUR FOODIE TABLE" title="My reservations">See the restaurant’s decision and manage upcoming table requests from your account.</PageIntro>
    <p className={error ? 'notice is-error' : 'notice is-success'} role="status">{error || notice}</p>
    <div className="button-row"><Link className="button button-reserve" to="/reservations">Book another table</Link><button className="button button-outline-dark" type="button" onClick={() => void loadReservations()}>Refresh bookings</button></div>
    <section className="reservation-history-section"><h2>Upcoming reservations</h2>{upcoming.length ? <div className="customer-order-list">{upcoming.map(reservationCard)}</div> : <div className="customer-orders-empty"><p>No upcoming table requests.</p><Link className="button button-reserve" to="/reservations">Request a table</Link></div>}</section>
    <section className="reservation-history-section"><h2>Past reservations</h2>{past.length ? <div className="customer-order-list">{past.map(reservationCard)}</div> : <p className="fine-print">Completed, rejected, and cancelled reservations will appear here.</p>}</section>
  </div>;
}

export function CustomerOrderDetailPage() {
  const { user, ready } = useAuth();
  const { orderId } = useParams();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [cancelNotice, setCancelNotice] = useState('');
  const [cancelling, setCancelling] = useState(false);

  async function cancelOrder() {
    if (!order) return;
    setCancelling(true); setCancelNotice('');
    try {
      const result = await api<{ message: string; status: string; paymentStatus: string }>(`/account/orders/${encodeURIComponent(order.id)}/cancel`, { method: 'POST' });
      setCancelNotice(result.message);
      setOrder({ ...order, status: result.status, paymentStatus: result.paymentStatus });
    } catch (reason) { setCancelNotice(reason instanceof Error ? reason.message : 'This order could not be cancelled.'); }
    finally { setCancelling(false); }
  }

  useEffect(() => {
    if (!ready) return;
    if (!user || (user.role !== 'customer' && user.role !== 'admin') || !orderId) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError('');
    api<{ order: CustomerOrder }>(`/account/orders/${encodeURIComponent(orderId)}`)
      .then((result) => { if (active) setOrder(result.order); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'This order could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ready, user?.id, user?.role, orderId, refreshKey]);

  useEffect(() => {
    if (!ready || !user || (user.role !== 'customer' && user.role !== 'admin') || !orderId || !order || ['delivered', 'completed', 'rejected', 'cancelled'].includes(order.status)) return;
    let active = true;
    const timer = window.setInterval(() => {
      api<{ order: CustomerOrder }>(`/account/orders/${encodeURIComponent(orderId)}`)
        .then((result) => { if (active) setOrder(result.order); })
        .catch(() => undefined);
    }, 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ready, user?.id, user?.role, orderId, order?.status]);

  if (!ready || loading) return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Order details" /><p className="quiet-message">Gathering your order details…</p></div>;
  if (!user) return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Sign in to continue">Sign in to see order details saved to your customer account.</PageIntro><Link className="button button-reserve" to="/account">Sign in</Link></div>;
  if (user.role !== 'customer' && user.role !== 'admin') return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Customer order details">Sign in with an account to view order details.</PageIntro><Link className="button button-reserve" to="/account">Sign in</Link></div>;
  if (error || !order) return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="YOUR FOODIE TABLE" title="Order unavailable">{error || 'That order could not be found in your account.'}</PageIntro><Link className="button button-reserve" to="/account/orders">Back to my orders</Link></div>;

  const stages = [
    { status: 'pending', label: 'Received' },
    { status: 'confirmed', label: 'Confirmed' },
    { status: 'preparing', label: 'Preparing' },
    { status: 'ready', label: 'Prepared' },
    { status: 'picked_up', label: 'Picked up' },
    { status: 'out_for_delivery', label: 'Out for delivery' },
    { status: 'delivered', label: 'Delivered' },
  ];
  const stageIndex = order.status === 'completed' ? stages.length - 1 : stages.findIndex((stage) => stage.status === order.status);

  return <div className="section-wrap page-content narrow-content customer-order-detail-page">
    <Link className="text-link order-back-link" to="/account/orders">← All my orders</Link>
    <PageIntro eyebrow={`ORDER · ${order.id.slice(-8).toUpperCase()}`} title="Track your order">Placed {orderDateLabel(order.createdAt)}. Updates refresh automatically while this page is open.</PageIntro>
    <section className="delivery-tracking-panel" aria-live="polite">
      <div className="delivery-tracking-heading"><span>DELIVERY STATUS</span><strong>{orderStatusLabel(order.status)}</strong></div>
      {order.status === 'awaiting_payment' ? <p className="delivery-pending-payment">Waiting for payment. The restaurant has not started preparing this order.</p> : order.status === 'cancelled' ? <p className="delivery-cancelled">This order was cancelled. Contact the restaurant if you need help.</p> : order.status === 'rejected' ? <p className="delivery-cancelled">The restaurant could not accept this order. Any online refund is shown in the payment status.</p> : <ol className="delivery-timeline">{stages.map((stage, index) => <li className={index <= stageIndex ? 'is-complete' : ''} key={stage.status}><span aria-hidden="true">{index < stageIndex ? '✓' : index === stageIndex ? '•' : ''}</span><small>{stage.label}</small></li>)}</ol>}
      <div className="delivery-receipt-meta"><p><span>Payment</span><strong>{orderPaymentLabel(order)}</strong></p><p><span>Payment status</span><strong>{orderStatusLabel(order.paymentStatus)}</strong></p></div>
    </section>
    {order.statusHistory && order.statusHistory.length > 0 && <section className="order-status-history"><p className="eyebrow">ORDER UPDATES</p><ol>{[...order.statusHistory].reverse().map((update, index) => <li key={`${update.status}-${update.changedAt}-${index}`}><span>{orderStatusLabel(update.status)}</span><time dateTime={update.changedAt}>{orderDateLabel(update.changedAt)}</time></li>)}</ol></section>}
    <section className="order-summary delivery-order-summary"><h2>In your order</h2><ul>{order.items.map((item) => <li key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{formatMoney(item.priceCents * item.quantity, order.currency)}</strong></li>)}</ul>
      <p><span>Subtotal</span><strong>{formatMoney(order.subtotalCents, order.currency)}</strong></p><p><span>Estimated tax</span><strong>{formatMoney(order.taxCents, order.currency)}</strong></p>{order.deliveryFeeCents > 0 && <p><span>Delivery charge</span><strong>{formatMoney(order.deliveryFeeCents, order.currency)}</strong></p>}<p className="receipt-total"><span>Total</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></p>
    </section>
    <section className="customer-delivery-address"><p className="eyebrow">DELIVERY TO</p><p>{order.address}</p>{order.deliveryInstructions && <p className="fine-print">Instructions: {order.deliveryInstructions}</p>}</section>
    {cancelNotice && <Status message={cancelNotice} error={order.status !== 'cancelled'} />}
    <div className="button-row"><button className="button button-outline-dark" type="button" onClick={() => setRefreshKey((key) => key + 1)}>Refresh order</button>{user.role === 'customer' && ['pending', 'awaiting_payment'].includes(order.status) && <button className="button button-outline-dark" type="button" disabled={cancelling} onClick={() => void cancelOrder()}>{cancelling ? 'Cancelling…' : 'Cancel order'}</button>}<Link className="button button-reserve" to="/account/orders">All my orders</Link></div>
  </div>;
}

function SavedAddresses() {
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);

  async function loadAddresses() {
    setLoading(true);
    try { setAddresses((await api<{ addresses: CustomerAddress[] }>('/addresses')).addresses); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Your saved addresses could not be loaded.'); setNoticeError(true); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadAddresses(); }, []);

  function beginEdit(address: CustomerAddress) {
    setEditingId(address.id);
    const form = document.getElementById('saved-address-form') as HTMLFormElement | null;
    if (!form) return;
    for (const [key, value] of Object.entries({ ...address, addressLabel: address.label })) {
      const fieldName = key === 'label' ? 'addressLabel' : key;
      const input = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${fieldName}"]`);
      if (input && fieldName !== 'isDefault') input.value = String(value ?? '');
    }
    const defaultInput = form.querySelector<HTMLInputElement>('input[name="isDefault"]');
    if (defaultInput) defaultInput.checked = address.isDefault;
  }

  async function saveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const body = {
      label: String(fields.get('addressLabel') || 'Home'), recipientName: String(fields.get('recipientName') || ''),
      phone: String(fields.get('phone') || ''), house: String(fields.get('house') || ''),
      locality: String(fields.get('locality') || ''), landmark: String(fields.get('landmark') || ''),
      city: String(fields.get('city') || ''), state: String(fields.get('state') || ''), pincode: String(fields.get('pincode') || ''),
      instructions: String(fields.get('instructions') || ''), isDefault: fields.get('isDefault') === 'on',
    };
    setSaving(true); setNotice(''); setNoticeError(false);
    try {
      const path = editingId ? `/addresses/${encodeURIComponent(editingId)}` : '/addresses';
      const result = await api<{ message: string; address?: CustomerAddress }>(path, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) });
      if (result.address) setAddresses((current) => [result.address!, ...current.filter((address) => address.id !== result.address!.id).map((address) => result.address!.isDefault ? { ...address, isDefault: false } : address)]);
      setNotice(result.message); form.reset(); setEditingId(''); await loadAddresses();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The address could not be saved.'); setNoticeError(true); }
    finally { setSaving(false); }
  }

  async function chooseDefault(id: string) {
    try { const result = await api<{ message: string }>(`/addresses/${encodeURIComponent(id)}/default`, { method: 'PATCH' }); setNotice(result.message); setNoticeError(false); await loadAddresses(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The default address could not be updated.'); setNoticeError(true); }
  }

  async function deleteAddress(id: string) {
    try { const result = await api<{ message: string }>(`/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' }); setNotice(result.message); setNoticeError(false); await loadAddresses(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'The address could not be deleted.'); setNoticeError(true); }
  }

  return <section className="saved-addresses" aria-labelledby="saved-addresses-title">
    <div className="saved-addresses-heading"><p className="eyebrow">DELIVERY DETAILS</p><h2 id="saved-addresses-title">Saved addresses</h2><p>These addresses are stored with your account and remain available across sessions.</p></div>
    {loading ? <p className="quiet-message">Loading your addresses…</p> : addresses.length === 0 ? <p className="fine-print">No saved addresses yet. Add one below or save a new address during checkout.</p> : <div className="saved-address-list">{addresses.map((address) => <article className="saved-address-card" key={address.id}>
      <div><p className="eyebrow">{address.label}{address.isDefault ? ' · DEFAULT' : ''}</p><h3>{address.recipientName}</h3><p>{address.formatted}</p><p>{address.phone}</p>{address.instructions && <p className="fine-print">{address.instructions}</p>}</div>
      <div className="button-row"><button className="button button-outline-dark" type="button" onClick={() => beginEdit(address)}>Edit</button>{!address.isDefault && <button className="button button-outline-dark" type="button" onClick={() => void chooseDefault(address.id)}>Make default</button>}<button className="button-remove" type="button" onClick={() => void deleteAddress(address.id)}>Delete</button></div>
    </article>)}</div>}
    <p className={'notice' + (noticeError ? ' is-error' : notice ? ' is-success' : '')} role="status">{notice}</p>
    <form id="saved-address-form" className="form-card saved-address-form" onSubmit={saveAddress}>
      <h3>{editingId ? 'Edit address' : 'Add an address'}</h3>
      <label htmlFor="saved-address-label">Save as</label><select id="saved-address-label" name="addressLabel"><option>Home</option><option>Work</option><option>Other</option></select>
      <label htmlFor="saved-recipient-name">Recipient name</label><input id="saved-recipient-name" name="recipientName" maxLength={100} required />
      <label htmlFor="saved-address-phone">Mobile number</label><input id="saved-address-phone" name="phone" type="tel" maxLength={25} pattern="(?:\+91[ -]?)?[6-9][0-9]{9}" title="Enter a 10-digit Indian mobile number." required />
      <label htmlFor="saved-address-house">House or flat number</label><input id="saved-address-house" name="house" maxLength={120} required />
      <label htmlFor="saved-address-locality">Street or locality</label><input id="saved-address-locality" name="locality" maxLength={160} required />
      <label htmlFor="saved-address-landmark">Landmark <span className="optional-label">Optional</span></label><input id="saved-address-landmark" name="landmark" maxLength={160} />
      <div className="form-row"><div><label htmlFor="saved-address-city">City</label><input id="saved-address-city" name="city" maxLength={100} required /></div><div><label htmlFor="saved-address-state">State</label><input id="saved-address-state" name="state" maxLength={100} required /></div></div>
      <label htmlFor="saved-address-pincode">PIN code</label><input id="saved-address-pincode" name="pincode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required />
      <label htmlFor="saved-address-instructions">Delivery instructions <span className="optional-label">Optional</span></label><textarea id="saved-address-instructions" name="instructions" maxLength={500} rows={2} />
      <label className="saved-address-default"><input type="checkbox" name="isDefault" /> Make this my default address</label>
      <div className="button-row"><button className="button button-reserve" type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Update address' : 'Save address'}</button>{editingId && <button className="button button-outline-dark" type="button" onClick={() => { setEditingId(''); (document.getElementById('saved-address-form') as HTMLFormElement | null)?.reset(); }}>Cancel edit</button>}</div>
    </form>
  </section>;
}

export function AccountPage() {
  const { user, login, register, logout } = useAuth();
  const { count: cartCount } = useCart();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [sending, setSending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const email = String(fields.get('email') || '');
    const password = String(fields.get('password') || '');
    setSending(true); setStatus('Please wait…'); setStatusError(false);
    try {
      const message = mode === 'login'
        ? await login(email, password)
        : await register(String(fields.get('name') || ''), email, String(fields.get('phone') || ''), password);
      setStatus(message); form.reset();
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'The account request could not be completed.'); setStatusError(true);
    } finally { setSending(false); }
  }

  async function signOut() {
    try { await logout(); setStatus('You are signed out.'); setStatusError(false); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Could not sign out.'); setStatusError(true); }
  }

  if (user) return <div className="section-wrap page-content narrow-content account-page">
    <PageIntro eyebrow="YOUR FOODIE TABLE" title={`Hello, ${user.name.split(' ')[0]}`}>You are signed in as {user.email}.</PageIntro>
    <Status message={status} error={statusError} />
    <section className="success-panel"><p>Your delivery orders and reservations are linked to this account when you place them while signed in.</p><div className="button-row"><Link className="button button-reserve" to="/account/orders">View my orders</Link>{user.role === 'customer' && <Link className="button button-outline-dark" to="/account/reservations">View my reservations</Link>}<Link className="button button-outline-dark" to="/account/notifications">View updates</Link>{cartCount > 0 && <Link className="button button-outline-dark" to="/checkout">Continue checkout</Link>}<button className="button button-outline-dark" type="button" onClick={() => void signOut()}>Sign out</button></div></section>
    {user.role === 'customer' && <SavedAddresses />}
  </div>;

  return (
    <div className="account-layout section-wrap page-content">
      <div className="account-intro"><p className="eyebrow">A SEAT WITH YOUR NAME ON IT</p><h1>Welcome<br /><em>to the table.</em></h1><p>Sign in to pick up where you left off, or create an account for an easier next visit.</p><Photo image={photography.room} className="account-photo" /></div>
      <div className="account-form-side">
        <Status message={status} error={statusError} />
        <section className="form-card account-card">
          <div className="account-tabs" role="group" aria-label="Choose account action">
            <button type="button" className={'tab-button' + (mode === 'login' ? ' is-active' : '')} aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setStatus(''); }}>Sign in</button>
            <button type="button" className={'tab-button' + (mode === 'register' ? ' is-active' : '')} aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setStatus(''); }}>Create account</button>
          </div>
          <form onSubmit={submitAccount}>
            {mode === 'register' && <><label htmlFor="account-name">Name</label><input id="account-name" name="name" autoComplete="name" maxLength={100} required /></>}
            <label htmlFor="account-email">Email</label><input id="account-email" name="email" type="email" autoComplete="email" maxLength={254} required />
            {mode === 'register' && <><label htmlFor="account-phone">Mobile number</label><input id="account-phone" name="phone" type="tel" autoComplete="tel" maxLength={25} pattern="(?:\+91[\s-]?)?[6-9][0-9]{9}" title="Enter a valid 10-digit Indian mobile number." required /></>}
            <label htmlFor="account-password">Password</label><input id="account-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 8 : undefined} maxLength={200} required />
            <button className="password-toggle" type="button" aria-controls="account-password" aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? 'Hide password' : 'Show password'}</button>
            {mode === 'register' && <p className="fine-print">Use at least 8 characters. Your password is stored as a salted hash.</p>}
            <button className="button button-reserve button-full" type="submit" disabled={sending}>{sending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          </form>
        </section>
        <button className="text-button" type="button" onClick={() => navigate('/menu')}>Continue browsing without an account</button>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return <div className="section-wrap page-content narrow-content"><PageIntro eyebrow="OOPS" title="That page isn’t here">The address may have changed. Head back to the menu or home page.</PageIntro><div className="button-row"><Link className="button button-reserve" to="/">Home</Link><Link className="button button-outline-dark" to="/menu">Menu</Link></div></div>;
}
