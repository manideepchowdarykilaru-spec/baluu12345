import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import bcrypt from 'bcryptjs';
import MongoStore from 'connect-mongo';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import {
  contentSecurityPolicy,
  crossOriginOpenerPolicy,
  crossOriginResourcePolicy,
  originAgentCluster,
  referrerPolicy,
  strictTransportSecurity,
  xContentTypeOptions,
  xDnsPrefetchControl,
  xDownloadOptions,
  xFrameOptions,
  xPermittedCrossDomainPolicies,
  xPoweredBy,
  xXssProtection,
} from 'helmet';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuditLog, ContactMessage, CustomerAddress, DiningTable, Notification, Order, Product, Reservation, ReservationSlot, User } from './models.js';
import { canTransitionOrder, canTransitionReservation, reservationRange, reservationSlotStarts, reservationTimesOverlap } from './domain.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDirectory, '../../.env') });

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI?.trim();
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? undefined : randomBytes(48).toString('hex'));
const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.trim().toLowerCase();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID?.trim();
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim();
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
const DEMO_ONLINE_PAYMENTS = ['development', 'test'].includes(process.env.NODE_ENV || '') && process.env.DEMO_ONLINE_PAYMENTS?.trim().toLowerCase() !== 'false';
const PAYMENT_CURRENCY = (process.env.PAYMENT_CURRENCY || 'INR').trim().toUpperCase();
const DELIVERY_FEE_CENTS = Number(process.env.DELIVERY_FEE_CENTS || 0);
const configuredClientOrigins = (process.env.CLIENT_ORIGIN || 'http://127.0.0.1:4000,http://127.0.0.1:4173,http://127.0.0.1:5173,http://localhost:4000,http://localhost:4173,http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const vercelOrigins = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
  .map((host) => {
    if (!host) return '';
    try { return new URL(host.includes('://') ? host : `https://${host}`).origin; }
    catch { return ''; }
  }).filter(Boolean);
const renderExternalOrigin = process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).origin : '';
const CLIENT_ORIGINS = new Set([...configuredClientOrigins, ...vercelOrigins, renderExternalOrigin].filter(Boolean));
const TAX_RATE = 0.08;
const SESSION_COOKIE = 'juniper.sid';
const RESTAURANT_ID = 'juniper-table';
const RESTAURANTS = [
  { id: RESTAURANT_ID, name: 'Foodie Table' },
  { id: 'chandrika-family-restaurant', name: 'Chandrika Family Restaurant' },
  { id: 'chiranjeevi-dhaba', name: 'Chiranjeevi Dhaba' },
  { id: 'thirumala-family-restaurant', name: 'Thirumala Family Restaurant' },
  { id: 'subrabath', name: 'Subrabath' },
  { id: 'sowjanya', name: 'Sowjanya' },
  { id: 'sithya-palav', name: 'Sithya Palav' },
  { id: 'paradise-biryani-restaurant', name: 'Paradise Biryani Restaurant' },
  { id: 'andhra-spice-kitchen', name: 'Andhra Spice Kitchen' },
  { id: 'royal-dum-biryani', name: 'Royal Dum Biryani' },
  { id: 'green-leaf-family-restaurant', name: 'Green Leaf Family Restaurant' },
] as const;

function restaurantNameFor(restaurantId: string): string {
  return RESTAURANTS.find((restaurant) => restaurant.id === restaurantId)?.name || 'Foodie Table';
}

const MENU = [
  { id: 'spring-rolls', name: 'Spring Rolls', category: 'Appetizers', description: 'Crisp vegetable rolls with sweet chili sauce.', priceCents: 57000, emoji: '🥟', displayOrder: 1 },
  { id: 'edamame', name: 'Edamame', category: 'Appetizers', description: 'Steamed soybeans finished with sea salt.', priceCents: 47000, emoji: '🫛', displayOrder: 2 },
  { id: 'potstickers', name: 'Potstickers', category: 'Appetizers', description: 'Pan-fried dumplings filled with pork and vegetables.', priceCents: 66000, emoji: '🥟', displayOrder: 3 },
  { id: 'chicken-biryani', name: 'Chicken Biryani', category: 'Biryani', description: 'Chicken, basmati rice, spices, and fresh herbs.', priceCents: 85000, emoji: '🍛', displayOrder: 4 },
  { id: 'mutton-biryani', name: 'Mutton Biryani', category: 'Biryani', description: 'Tender mutton with fragrant basmati rice and spices.', priceCents: 104000, emoji: '🍛', displayOrder: 5 },
  { id: 'vegetable-biryani', name: 'Vegetable Biryani', category: 'Biryani', description: 'Seasonal vegetables with basmati rice and herbs.', priceCents: 76000, emoji: '🍚', displayOrder: 6 },
  { id: 'grilled-chicken', name: 'Grilled Chicken', category: 'Entrees', description: 'Marinated chicken with roasted vegetables.', priceCents: 123000, emoji: '🍗', displayOrder: 7 },
  { id: 'salmon', name: 'Salmon', category: 'Entrees', description: 'Grilled salmon with quinoa and asparagus.', priceCents: 142000, emoji: '🐟', displayOrder: 8 },
  { id: 'veggie-burger', name: 'Veggie Burger', category: 'Entrees', description: 'Black bean patty with avocado, lettuce, and tomato.', priceCents: 104000, emoji: '🍔', displayOrder: 9 },
  { id: 'cheesecake', name: 'Cheesecake', category: 'Desserts', description: 'New York-style cheesecake with a graham cracker crust.', priceCents: 66000, emoji: '🍰', displayOrder: 10 },
  { id: 'lava-cake', name: 'Chocolate Lava Cake', category: 'Desserts', description: 'Warm chocolate cake with a soft chocolate center.', priceCents: 76000, emoji: '🍫', displayOrder: 11 },
  { id: 'fruit-salad', name: 'Fresh Fruit Salad', category: 'Desserts', description: 'Seasonal fresh fruit with whipped cream.', priceCents: 57000, emoji: '🍓', displayOrder: 12 },
];

// A clearly labelled sample floor plan. Replace these positions and capacities with the venue's verified layout.
const DINING_TABLE_LAYOUT = [
  { id: 'T01', section: 'A', seats: 2, row: 1, column: 1 },
  { id: 'T02', section: 'A', seats: 4, row: 1, column: 2 },
  { id: 'T03', section: 'A', seats: 4, row: 2, column: 1 },
  { id: 'T04', section: 'A', seats: 2, row: 2, column: 2 },
  { id: 'T05', section: 'B', seats: 4, row: 1, column: 1 },
  { id: 'T06', section: 'B', seats: 2, row: 1, column: 2 },
  { id: 'T07', section: 'B', seats: 4, row: 2, column: 1 },
  { id: 'T08', section: 'B', seats: 6, row: 2, column: 2 },
  { id: 'T09', section: 'C', seats: 2, row: 1, column: 1 },
  { id: 'T10', section: 'C', seats: 4, row: 1, column: 2 },
  { id: 'T11', section: 'C', seats: 6, row: 2, column: 1 },
  { id: 'T12', section: 'C', seats: 4, row: 2, column: 2 },
];
const DINING_TABLES = RESTAURANTS.flatMap((restaurant, index) => DINING_TABLE_LAYOUT.map((table) => ({
  ...table,
  id: index === 0 ? table.id : `V${String(index + 1).padStart(2, '0')}-${table.id}`,
  restaurantId: restaurant.id,
})));

const app = express();
app.disable('x-powered-by');
let appReady: Promise<void> | undefined;
app.use((_request, response, next) => {
  if (!appReady) return next();
  void appReady.then(() => next(), (error: unknown) => {
    console.error('The API could not start:', error instanceof Error ? error.message : error);
    if (!response.headersSent) response.status(503).json({ error: 'The API is temporarily unavailable.' });
  });
});
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(
  contentSecurityPolicy({
    directives: {
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'script-src': ["'self'", 'https://checkout.razorpay.com'],
      'connect-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com'],
      'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      'img-src': ["'self'", 'data:', 'https://*.razorpay.com'],
    },
  }),
  crossOriginOpenerPolicy(),
  crossOriginResourcePolicy(),
  originAgentCluster(),
  referrerPolicy(),
  strictTransportSecurity(),
  xContentTypeOptions(),
  xDnsPrefetchControl(),
  xDownloadOptions(),
  xFrameOptions(),
  xPermittedCrossDomainPolicies(),
  xPoweredBy(),
  xXssProtection(),
);
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '64kb' }), async (request, response) => {
  if (!RAZORPAY_WEBHOOK_SECRET) return response.status(503).json({ error: 'Payment webhook is not configured.' });
  const signature = request.header('x-razorpay-signature') || '';
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
  const expected = createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest();
  let submitted: Buffer;
  try { submitted = Buffer.from(signature, 'hex'); } catch { return response.status(401).json({ error: 'Invalid webhook signature.' }); }
  if (!signature || expected.length !== submitted.length || !timingSafeEqual(expected, submitted)) return response.status(401).json({ error: 'Invalid webhook signature.' });
  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string; status?: string } } } };
  try { event = JSON.parse(rawBody.toString('utf8')) as typeof event; }
  catch { return response.status(400).json({ error: 'Invalid webhook payload.' }); }
  if (event.event !== 'payment.captured') return response.json({ received: true, ignored: true });
  const payment = event.payload?.payment?.entity;
  if (!payment?.id || !payment.order_id || payment.status !== 'captured') return response.status(400).json({ error: 'Captured payment details are missing.' });
  const order = await Order.findOne({ razorpayOrderId: payment.order_id });
  if (!order) return response.status(404).json({ error: 'The linked order could not be found.' });
  if (payment.amount !== order.totalCents || payment.currency !== order.currency) return response.status(409).json({ error: 'Payment amount or currency does not match the order.' });
  if (order.paymentStatus === 'refund_pending' && !order.razorpayPaymentId) {
    // The status poll flagged the refund without the payment ID; record it here.
    await Order.updateOne({ _id: order._id, paymentStatus: 'refund_pending', razorpayPaymentId: { $in: [null, ''] } }, { $set: { razorpayPaymentId: payment.id } });
    return response.json({ received: true, alreadyProcessed: true });
  }
  if (order.paymentStatus === 'paid' || (order.paymentStatus === 'refund_pending' && order.razorpayPaymentId === payment.id)) return response.json({ received: true, alreadyProcessed: true });
  if (order.status === 'cancelled' && order.paymentStatus === 'pending') {
    await Order.updateOne({ _id: order._id, paymentStatus: 'pending', status: 'cancelled' }, { $set: { paymentStatus: 'refund_pending', razorpayPaymentId: payment.id } });
    await safelyNotify(notifyRefundPending(order));
    return response.json({ received: true, refundPending: true });
  }
  if (order.status !== 'awaiting_payment' || order.paymentStatus !== 'pending') return response.status(409).json({ error: 'The order is not awaiting payment.' });
  await Order.updateOne({ _id: order._id, paymentStatus: 'pending', status: 'awaiting_payment' }, {
    $set: { paymentStatus: 'paid', status: 'pending', razorpayPaymentId: payment.id },
    $push: { statusHistory: { status: 'pending', changedAt: new Date() } },
  });
  await safelyNotify(notifyOrderPlaced(order));
  return response.json({ received: true });
});
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

const api = express.Router();
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});
const reservationStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Reservation status checks are temporarily limited. Please try again shortly.' },
});
const orderStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Order status checks are temporarily limited. Please try again shortly.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many account attempts. Please try again in a few minutes.' },
});

const nameSchema = z.string().trim().min(1, 'Enter your name.').max(100);
const emailSchema = z.string().trim().email('Enter a valid email address.').max(254).transform((value) => value.toLowerCase());
const phoneSchema = z.string().trim().regex(/^\+?[0-9\s().-]{7,25}$/, 'Enter a valid phone number.').refine((value) => {
  const digits = value.replace(/\D/g, '');
  const mobile = digits.length === 10 ? digits : digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : '';
  return /^[6-9]\d{9}$/.test(mobile);
}, 'Enter a valid 10-digit Indian mobile number.');

const contactSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  message: z.string().trim().min(3, 'Write a short message.').max(2000),
});

const restaurantIdSchema = z.string().trim().min(1).max(80)
  .refine((id) => RESTAURANTS.some((restaurant) => restaurant.id === id), 'Choose a restaurant from the list.')
  .default(RESTAURANT_ID);

const reservationSchema = z.object({
  restaurantId: restaurantIdSchema,
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date.'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Choose a valid time.'),
  guests: z.coerce.number().int().min(1).max(6),
  tableId: z.string().trim().min(1).max(12),
  specialRequests: z.string().trim().max(500).default(''),
  items: z.array(z.object({ id: z.string().min(1).max(80), quantity: z.coerce.number().int().min(1).max(10) })).max(20).default([]),
});

const reservationAvailabilitySchema = z.object({
  restaurantId: restaurantIdSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date.'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Choose a valid time.'),
  guests: z.coerce.number().int().min(1).max(6),
});

const reservationTrackingSchema = z.object({
  token: z.string().min(20).max(128),
});

const orderSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  address: z.string().trim().min(8, 'Enter your full delivery address, including area and city.').max(1000).optional(),
  addressId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  deliveryAddressSnapshot: z.object({
    label: z.enum(['Home', 'Work', 'Other']),
    recipientName: nameSchema,
    phone: phoneSchema,
    house: z.string().trim().min(1).max(120),
    locality: z.string().trim().min(1).max(160),
    landmark: z.string().trim().max(160).default(''),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    pincode: z.string().regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code.'),
    instructions: z.string().trim().max(500).default(''),
  }).optional(),
  deliveryInstructions: z.string().trim().max(500).default(''),
  paymentMethod: z.enum(['cash_on_delivery', 'razorpay', 'demo_online']),
  items: z.array(z.object({ id: z.string().min(1).max(80), quantity: z.coerce.number().int().min(1).max(10) })).min(1).max(20),
}).refine((input) => Boolean(input.addressId || input.address || input.deliveryAddressSnapshot), {
  message: 'Choose a saved address or enter your delivery address.',
  path: ['address'],
});

const addressInputSchema = z.object({
  label: z.enum(['Home', 'Work', 'Other']),
  recipientName: nameSchema,
  phone: phoneSchema,
  house: z.string().trim().min(1).max(120),
  locality: z.string().trim().min(1).max(160),
  landmark: z.string().trim().max(160).default(''),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code.'),
  instructions: z.string().trim().max(500).default(''),
  isDefault: z.boolean().default(false),
});

const managerCreateSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  username: z.string().trim().min(3).max(32).regex(/^[a-z0-9._-]+$/i).transform((value) => value.toLowerCase()),
});

const paymentVerificationSchema = z.object({
  razorpayOrderId: z.string().min(8).max(80),
  razorpayPaymentId: z.string().min(8).max(80),
  razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/i),
});

const orderTrackingSchema = z.object({ token: z.string().min(20).max(128) });

const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const adminLoginSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-z0-9._-]+$/i).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200),
});

const orderStatusSchema = z.object({ status: z.enum(['awaiting_payment', 'pending', 'confirmed', 'rejected', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'completed', 'cancelled']) });
const reservationStatusSchema = z.object({ status: z.enum(['pending', 'confirmed', 'rejected', 'seated', 'completed', 'cancelled']) });

function getSessionUserId(request: Request): string | null {
  return request.session.userId || null;
}

function publicUser(user: { id: string; name: string; email: string; role: 'customer' | 'manager' | 'admin' }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function formatDeliveryAddress(address: { house: string; locality: string; landmark?: string; city: string; state: string; pincode: string }): string {
  return [address.house, address.locality, address.landmark, address.city, address.state, address.pincode].filter(Boolean).join(', ');
}

function publicAddress(address: {
  _id: unknown; label: string; recipientName: string; phone: string; house: string; locality: string;
  landmark?: string; city: string; state: string; pincode: string; instructions?: string; isDefault?: boolean;
}) {
  return {
    id: String(address._id), label: address.label, recipientName: address.recipientName, phone: address.phone,
    house: address.house, locality: address.locality, landmark: address.landmark || '', city: address.city,
    state: address.state, pincode: address.pincode, instructions: address.instructions || '', isDefault: Boolean(address.isDefault),
    formatted: formatDeliveryAddress(address),
  };
}

async function addNotification(userId: string, input: { type: 'order' | 'reservation' | 'account'; title: string; message: string; href: string; eventKey: string }): Promise<void> {
  await Notification.updateOne(
    { dedupeKey: `${input.eventKey}:${userId}` },
    { $setOnInsert: { userId: new mongoose.Types.ObjectId(userId), type: input.type, title: input.title, message: input.message, href: input.href, dedupeKey: `${input.eventKey}:${userId}` } },
    { upsert: true },
  );
}

async function notifyManagers(restaurantId: string, input: { type: 'order' | 'reservation'; title: string; message: string; href: string; eventKey: string }): Promise<void> {
  const managers = await User.find({ role: 'manager', restaurantId, active: { $ne: false } }).select('_id').lean();
  const recipients = managers.length
    ? managers
    : await User.find({ role: 'admin', active: { $ne: false } }).select('_id').lean();
  await Promise.all(recipients.map((recipient) => addNotification(String(recipient._id), input)));
}

async function safelyNotify(work: Promise<void>): Promise<void> {
  try { await work; }
  catch { console.error('An in-app notification could not be stored.'); }
}

async function notifyOrderPlaced(order: { _id: unknown; userId?: unknown; restaurantId?: string; totalCents: number; currency?: string }): Promise<void> {
  const orderId = String(order._id);
  const total = new Intl.NumberFormat('en-IN', { style: 'currency', currency: order.currency || 'INR', maximumFractionDigits: 0 }).format(order.totalCents / 100);
  const notice = { type: 'order' as const, title: 'Order placed', message: `Your delivery order ${orderId.slice(-6).toUpperCase()} is with the restaurant. Total ${total}.`, href: `/account/orders/${orderId}`, eventKey: `order:${orderId}:placed` };
  if (order.userId) await addNotification(String(order.userId), notice);
  await notifyManagers(order.restaurantId || RESTAURANT_ID, { type: 'order', title: 'New delivery order', message: `Order ${orderId.slice(-6).toUpperCase()} is ready for review.`, href: '/manager', eventKey: `order:${orderId}:placed` });
}

async function notifyOrderStatus(order: { _id: unknown; userId?: unknown }, status: string): Promise<void> {
  if (!order.userId) return;
  const labels: Record<string, string> = { confirmed: 'accepted', rejected: 'rejected', preparing: 'being prepared', ready: 'ready for pickup', picked_up: 'picked up', out_for_delivery: 'out for delivery', delivered: 'delivered', completed: 'complete', cancelled: 'cancelled' };
  const label = labels[status] || status.replaceAll('_', ' ');
  const orderId = String(order._id);
  await addNotification(String(order.userId), { type: 'order', title: `Order ${label}`, message: `Your delivery order ${orderId.slice(-6).toUpperCase()} is ${label}.`, href: `/account/orders/${orderId}`, eventKey: `order:${orderId}:status:${status}` });
}

async function notifyRefundPending(order: { _id: unknown; userId?: unknown }): Promise<void> {
  if (!order.userId) return;
  const orderId = String(order._id);
  await addNotification(String(order.userId), { type: 'order', title: 'Refund pending', message: `A refund for delivery order ${orderId.slice(-6).toUpperCase()} needs to be processed by the restaurant.`, href: `/account/orders/${orderId}`, eventKey: `order:${orderId}:refund_pending` });
}

async function notifyReservationStatus(reservation: { _id: unknown; userId?: unknown }, status: string): Promise<void> {
  if (!reservation.userId) return;
  const labels: Record<string, string> = { pending: 'received', confirmed: 'confirmed', rejected: 'rejected', seated: 'marked seated', completed: 'completed', cancelled: 'cancelled' };
  const label = labels[status] || status;
  const reservationId = String(reservation._id);
  await addNotification(String(reservation.userId), { type: 'reservation', title: `Reservation ${label}`, message: `Your table request ${reservationId.slice(-6).toUpperCase()} was ${label}.`, href: '/account/reservations', eventKey: `reservation:${reservationId}:status:${status}` });
}

async function recordStaffAction(request: Request, actorRole: 'admin' | 'manager', action: string, resourceType: string, resourceId: string, restaurantId?: string, details: Record<string, unknown> = {}): Promise<void> {
  const actorId = getSessionUserId(request);
  if (!actorId) return;
  await AuditLog.create({ actorId, actorRole, action, resourceType, resourceId, restaurantId, details });
}

interface RazorpayGatewayOrder {
  id: string;
  amount: number;
  currency: string;
  amount_paid?: number;
  status?: string;
}

interface RazorpayGatewayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}

async function razorpayRequest<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Online payments are not configured.');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('Razorpay request failed with HTTP ' + response.status + '.');
    throw new Error('The online payment service could not complete the request. Please try again or choose cash on delivery.');
  }
  return payload as T;
}

async function requireAdmin(request: Request, response: Response, next: NextFunction): Promise<void> {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.status(401).json({ error: 'Sign in with an administrator account to continue.' });
    return;
  }
  const user = await User.findById(userId).select('role active').lean();
  if (!user || user.role !== 'admin' || user.active === false) {
    response.status(403).json({ error: 'Administrator access is required.' });
    return;
  }
  next();
}

async function requireManager(request: Request, response: Response, next: NextFunction): Promise<void> {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.status(401).json({ error: 'Sign in with your restaurant manager account to continue.' });
    return;
  }
  const user = await User.findById(userId).select('role active mustChangePassword restaurantId').lean();
  if (!user || user.role !== 'manager' || user.active === false) {
    response.status(403).json({ error: 'Restaurant manager access is required.' });
    return;
  }
  if (user.mustChangePassword) {
    response.status(403).json({ error: 'Change your temporary password before using the manager desk.' });
    return;
  }
  next();
}

async function requireCustomer(request: Request, response: Response, next: NextFunction): Promise<void> {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.status(401).json({ error: 'Sign in to manage your customer account.' });
    return;
  }
  const user = await User.findById(userId).select('role active').lean();
  if (!user || !['customer', 'admin'].includes(user.role) || user.active === false) {
    response.status(403).json({ error: 'Sign in with a customer or administrator account to manage saved addresses.' });
    return;
  }
  next();
}

async function requireOrderAccess(request: Request, response: Response, next: NextFunction): Promise<void> {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.status(401).json({ error: 'Sign in to view order history.' });
    return;
  }
  const user = await User.findById(userId).select('role').lean();
  if (!user) {
    response.status(401).json({ error: 'Your session expired. Sign in again to view orders.' });
    return;
  }
  if (user.role !== 'customer' && user.role !== 'admin') {
    response.status(403).json({ error: 'Order history is not available for this account.' });
    return;
  }
  next();
}

async function requireOrderAccount(request: Request, response: Response, next: NextFunction): Promise<void> {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.status(401).json({ error: 'Sign in before placing an order so it is saved to your order history.' });
    return;
  }
  const user = await User.findById(userId).select('role').lean();
  if (!user) {
    response.status(401).json({ error: 'Your session expired. Sign in again before placing an order.' });
    return;
  }
  if (user.role !== 'customer' && user.role !== 'admin') {
    response.status(403).json({ error: 'This account cannot place delivery orders.' });
    return;
  }
  next();
}

function validFutureDateTime(date: string, time: string): boolean {
  const dateParts = date.split('-').map(Number);
  const timeParts = time.split(':').map(Number);
  const calendarDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  const requested = new Date(`${date}T${time}:00+05:30`);
  return calendarDate.getUTCFullYear() === dateParts[0]
    && calendarDate.getUTCMonth() === dateParts[1] - 1
    && calendarDate.getUTCDate() === dateParts[2]
    && timeParts[0] >= 0 && timeParts[0] <= 23
    && timeParts[1] >= 0 && timeParts[1] <= 59
    && requested.getTime() > Date.now();
}

api.get('/health', (_request, response) => {
  response.json({ status: 'ok', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

api.get('/restaurants', (_request, response) => {
  return response.json({ restaurants: RESTAURANTS });
});

api.get('/reservations/availability', async (request, response) => {
  const input = reservationAvailabilitySchema.parse(request.query);
  if (!validFutureDateTime(input.date, input.time)) {
    return response.status(400).json({ error: 'Choose a valid future reservation date and time.' });
  }
  const range = reservationRange(input.date, input.time);
  const previousDay = new Date(`${input.date}T00:00:00+05:30`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const previousDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(previousDay);
  const [tables, reservations, slotLocks] = await Promise.all([
    DiningTable.find({ restaurantId: input.restaurantId, active: true, seats: { $gte: input.guests } }).sort({ section: 1, row: 1, column: 1 }).lean(),
    Reservation.find({ restaurantId: input.restaurantId, date: { $in: [previousDate, input.date] }, tableId: { $exists: true }, status: { $in: ['pending', 'confirmed', 'seated'] } }).select('tableId date time startsAt endsAt').lean(),
    ReservationSlot.find({ slotStart: { $in: reservationSlotStarts(range.startsAt, range.endsAt) } }).select('tableId').lean(),
  ]);
  const lockedTableIds = new Set(slotLocks.map((slot) => slot.tableId));
  return response.json({
    tables: tables.map((table) => ({
      id: table.id,
      section: table.section,
      seats: table.seats,
      row: table.row,
      column: table.column,
      available: !lockedTableIds.has(table.id) && !reservations.some((reservation) => reservation.tableId === table.id && reservationTimesOverlap(reservation, range.startsAt, range.endsAt)),
    })),
  });
});

api.get('/reservations/:id/status', reservationStatusLimiter, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'Reservation status could not be found.' });
  const { token } = reservationTrackingSchema.parse(request.query);
  const trackingTokenHash = createHash('sha256').update(token).digest('hex');
  const reservation = await Reservation.findOne({ _id: request.params.id, trackingTokenHash })
    .select('status tableId date time guests currency').lean();
  if (!reservation) return response.status(404).json({ error: 'Reservation status could not be found.' });
  return response.json({
    status: reservation.status || 'pending',
    tableId: reservation.tableId || 'Table not assigned',
    date: reservation.date,
    time: reservation.time,
    guests: reservation.guests,
    currency: reservation.currency || 'INR',
  });
});

api.get('/auth/me', async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) return response.json({ user: null });
  const user = await User.findById(userId).select('name email role active mustChangePassword').lean();
  if (user?.active === false) {
    request.session.destroy(() => undefined);
    return response.json({ user: null });
  }
  if (!user) {
    request.session.destroy(() => undefined);
    return response.json({ user: null });
  }
  return response.json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role as 'customer' | 'manager' | 'admin', mustChangePassword: Boolean(user.mustChangePassword) } });
});

api.get('/notifications', async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) return response.status(401).json({ error: 'Sign in to view your notifications.' });
  const user = await User.findById(userId).select('active').lean();
  if (!user || user.active === false) return response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).select('type title message href readAt createdAt').lean(),
    Notification.countDocuments({ userId, readAt: null }),
  ]);
  return response.json({ unreadCount, notifications: notifications.map((notification) => ({ id: String(notification._id), type: notification.type, title: notification.title, message: notification.message, href: notification.href, readAt: notification.readAt, createdAt: notification.createdAt })) });
});

api.patch('/notifications/:id/read', async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) return response.status(401).json({ error: 'Sign in to manage your notifications.' });
  const user = await User.findById(userId).select('active').lean();
  if (!user || user.active === false) return response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That notification could not be found.' });
  const notification = await Notification.findOneAndUpdate({ _id: request.params.id, userId }, { $set: { readAt: new Date() } }, { new: true }).select('_id readAt').lean();
  if (!notification) return response.status(404).json({ error: 'That notification could not be found in your account.' });
  return response.json({ message: 'Notification marked as read.', id: String(notification._id), readAt: notification.readAt });
});

api.post('/notifications/read-all', async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) return response.status(401).json({ error: 'Sign in to manage your notifications.' });
  const user = await User.findById(userId).select('active').lean();
  if (!user || user.active === false) return response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  const result = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
  return response.json({ message: 'Notifications marked as read.', modifiedCount: result.modifiedCount });
});

api.post('/auth/register', authLimiter, async (request, response) => {
  const input = registerSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await User.create({ name: input.name, email: input.email, phone: input.phone, passwordHash });
  request.session.userId = String(user._id);
  await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
  response.status(201).json({ message: 'Your account is ready.', user: publicUser({ id: String(user._id), name: user.name, email: user.email, role: 'customer' }) });
});

api.post('/auth/login', authLimiter, async (request, response) => {
  const input = loginSchema.parse(request.body);
  const user = await User.findOne({ email: input.email }).select('+passwordHash name email role active');
  if (!user || user.active === false || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (user.role !== 'customer') {
    return response.status(403).json({ error: 'Staff accounts must sign in with a staff username.' });
  }
  request.session.userId = String(user._id);
  await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
  return response.json({ message: 'You are signed in.', user: publicUser({ id: String(user._id), name: user.name, email: user.email, role: 'customer' }) });
});

api.post('/auth/admin-login', authLimiter, async (request, response) => {
  const input = adminLoginSchema.parse(request.body);
  const user = await User.findOne({ username: input.username, role: { $in: ['admin', 'manager'] } }).select('+passwordHash name email role active mustChangePassword');
  if (!user || user.active === false || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return response.status(401).json({ error: 'Username or password is incorrect, or this staff account is inactive.' });
  }
  request.session.userId = String(user._id);
  await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
  return response.json({ message: user.role === 'admin' ? 'You are signed in to the administrator desk.' : 'You are signed in to the manager desk.', user: { ...publicUser({ id: String(user._id), name: user.name, email: user.email, role: user.role as 'manager' | 'admin' }), mustChangePassword: Boolean(user.mustChangePassword) } });
});

api.post('/auth/change-password', authLimiter, async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) return response.status(401).json({ error: 'Sign in before changing your password.' });
  const input = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'Use at least 10 characters for the new password.').max(200) }).parse(request.body);
  const user = await User.findById(userId).select('+passwordHash role');
  if (!user) return response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) return response.status(400).json({ error: 'Your current password is incorrect.' });
  user.passwordHash = await bcrypt.hash(input.newPassword, 12);
  user.mustChangePassword = false;
  await user.save();
  return response.json({ message: 'Your password has been updated.' });
});

api.get('/addresses', requireCustomer, async (request, response) => {
  const addresses = await CustomerAddress.find({ userId: getSessionUserId(request) }).sort({ isDefault: -1, createdAt: -1 }).lean();
  return response.json({ addresses: addresses.map(publicAddress) });
});

api.post('/addresses', requireCustomer, async (request, response) => {
  const userId = getSessionUserId(request)!;
  const input = addressInputSchema.parse(request.body);
  const currentCount = await CustomerAddress.countDocuments({ userId });
  if (currentCount >= 10) return response.status(409).json({ error: 'You can save up to 10 delivery addresses.' });
  const isDefault = input.isDefault || currentCount === 0;
  if (isDefault) await CustomerAddress.updateMany({ userId }, { $set: { isDefault: false } });
  const address = await CustomerAddress.create({ ...input, isDefault, userId });
  return response.status(201).json({ message: 'Address saved to your account.', address: publicAddress(address.toObject()) });
});

api.put('/addresses/:id', requireCustomer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That saved address could not be found.' });
  const userId = getSessionUserId(request)!;
  const input = addressInputSchema.parse(request.body);
  const current = await CustomerAddress.findOne({ _id: request.params.id, userId });
  if (!current) return response.status(404).json({ error: 'That saved address could not be found.' });
  if (input.isDefault) await CustomerAddress.updateMany({ userId, _id: { $ne: current._id } }, { $set: { isDefault: false } });
  Object.assign(current, input);
  await current.save();
  return response.json({ message: 'Address updated.', address: publicAddress(current.toObject()) });
});

api.patch('/addresses/:id/default', requireCustomer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That saved address could not be found.' });
  const userId = getSessionUserId(request)!;
  const address = await CustomerAddress.findOne({ _id: request.params.id, userId });
  if (!address) return response.status(404).json({ error: 'That saved address could not be found.' });
  await CustomerAddress.updateMany({ userId }, { $set: { isDefault: false } });
  address.isDefault = true;
  await address.save();
  return response.json({ message: 'Default delivery address updated.' });
});

api.delete('/addresses/:id', requireCustomer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That saved address could not be found.' });
  const userId = getSessionUserId(request)!;
  const address = await CustomerAddress.findOneAndDelete({ _id: request.params.id, userId });
  if (!address) return response.status(404).json({ error: 'That saved address could not be found.' });
  if (address.isDefault) {
    const nextDefault = await CustomerAddress.findOne({ userId }).sort({ createdAt: 1 });
    if (nextDefault) { nextDefault.isDefault = true; await nextDefault.save(); }
  }
  return response.json({ message: 'Address deleted.' });
});

api.post('/auth/logout', async (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return response.json({ message: 'You are signed out.' });
  });
});

api.post('/contact', formLimiter, async (request, response) => {
  const input = contactSchema.parse(request.body);
  await ContactMessage.create(input);
  response.status(201).json({ message: 'Thanks. Your message has been received.' });
});

api.post('/reservations', formLimiter, async (request, response) => {
  const input = reservationSchema.parse(request.body);
  if (!validFutureDateTime(input.date, input.time)) {
    return response.status(400).json({ error: 'Choose a valid future reservation date and time.' });
  }
  const range = reservationRange(input.date, input.time);
  const previousDay = new Date(`${input.date}T00:00:00+05:30`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const previousDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(previousDay);
  const table = await DiningTable.findOne({ id: input.tableId, restaurantId: input.restaurantId, active: true }).lean();
  if (!table || table.seats < input.guests) {
    return response.status(400).json({ error: 'Choose a table that fits your party.' });
  }
  const activeReservations = await Reservation.find({ restaurantId: input.restaurantId, date: { $in: [previousDate, input.date] }, tableId: input.tableId, status: { $in: ['pending', 'confirmed', 'seated'] } }).select('date time startsAt endsAt').lean();
  const requestedSlots = reservationSlotStarts(range.startsAt, range.endsAt);
  const [overlappingReservation, reservedSlot] = await Promise.all([
    Promise.resolve(activeReservations.some((reservation) => reservationTimesOverlap(reservation, range.startsAt, range.endsAt))),
    ReservationSlot.exists({ tableId: input.tableId, slotStart: { $in: requestedSlots } }),
  ]);
  if (overlappingReservation || reservedSlot) {
    return response.status(409).json({ error: 'That table was just requested for this time. Choose another table or time.' });
  }

  const quantityById = new Map<string, number>();
  for (const item of input.items) {
    const quantity = (quantityById.get(item.id) || 0) + item.quantity;
    if (quantity > 10) return response.status(400).json({ error: 'An item quantity cannot exceed 10.' });
    quantityById.set(item.id, quantity);
  }
  const products = await Product.find({ id: { $in: [...quantityById.keys()] }, active: true }).lean();
  const productById = new Map(products.map((product) => [product.id, product]));
  if (productById.size !== quantityById.size) {
    return response.status(400).json({ error: 'A menu item in your pre-order is no longer available.' });
  }
  const items = [...quantityById.entries()].map(([id, quantity]) => {
    const product = productById.get(id)!;
    return { productId: product.id, name: product.name, quantity, priceCents: product.priceCents };
  });
  const preorderTotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const trackingToken = randomBytes(32).toString('base64url');

  let reservation: InstanceType<typeof Reservation> | undefined;
  try {
    reservation = await Reservation.create({
      name: input.name,
      email: input.email,
      phone: input.phone,
      date: input.date,
      time: input.time,
      guests: input.guests,
      tableId: input.tableId,
      restaurantId: input.restaurantId,
      specialRequests: input.specialRequests,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      currency: PAYMENT_CURRENCY,
      items,
      preorderTotalCents,
      trackingTokenHash: createHash('sha256').update(trackingToken).digest('hex'),
      userId: getSessionUserId(request) || undefined,
      statusHistory: [{ status: 'pending', changedAt: new Date() }],
    });
    await ReservationSlot.insertMany(requestedSlots.map((slotStart) => ({ tableId: input.tableId, slotStart, reservationId: reservation._id })));
  } catch (error) {
    if (reservation?._id) {
      await ReservationSlot.deleteMany({ reservationId: reservation._id });
      await Reservation.deleteOne({ _id: reservation._id });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return response.status(409).json({ error: 'That table was just requested for this time. Choose another table or time.' });
    }
    throw error;
  }
  await safelyNotify((async () => {
    const event = { type: 'reservation' as const, title: 'New table request', message: `A table request for ${input.guests} guest${input.guests === 1 ? '' : 's'} is waiting for review.`, href: '/manager', eventKey: `reservation:${String(reservation._id)}:submitted` };
    if (reservation.userId) await addNotification(String(reservation.userId), { ...event, message: 'Your table request was received and is waiting for the restaurant.' });
    await notifyManagers(input.restaurantId, event);
  })());
  return response.status(201).json({
    message: 'Your table request has been saved. The restaurant will confirm it with you.',
    restaurantName: restaurantNameFor(input.restaurantId),
    reservation: {
      id: String(reservation._id),
      tableId: table.id,
      section: table.section,
      seats: table.seats,
      currency: PAYMENT_CURRENCY,
      items,
      preorderTotalCents,
      status: reservation.status,
    },
    trackingToken,
  });
});

api.get('/account/reservations', requireCustomer, async (request, response) => {
  const reservations = await Reservation.find({ userId: getSessionUserId(request) }).sort({ date: 1, time: 1, createdAt: -1 }).lean();
  return response.json({ reservations: reservations.map((reservation) => ({
    id: String(reservation._id), date: reservation.date, time: reservation.time, guests: reservation.guests,
    restaurantName: restaurantNameFor(reservation.restaurantId || RESTAURANT_ID),
    tableId: reservation.tableId || 'Table not assigned', status: reservation.status || 'pending',
    items: reservation.items || [], preorderTotalCents: reservation.preorderTotalCents || 0,
    currency: reservation.currency || 'INR', specialRequests: reservation.specialRequests || '',
    statusHistory: reservation.statusHistory || [], createdAt: reservation.createdAt,
  })) });
});

api.post('/account/reservations/:id/cancel', requireCustomer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That reservation could not be found.' });
  const reservation = await Reservation.findOne({ _id: request.params.id, userId: getSessionUserId(request) });
  if (!reservation) return response.status(404).json({ error: 'That reservation could not be found in your account.' });
  if (!['pending', 'confirmed'].includes(reservation.status)) return response.status(409).json({ error: 'This reservation can no longer be cancelled online.' });
  const startsAt = reservation.startsAt || reservationRange(reservation.date, reservation.time).startsAt;
  if (startsAt.getTime() <= Date.now()) return response.status(409).json({ error: 'A reservation that has already started cannot be cancelled online.' });
  reservation.status = 'cancelled';
  reservation.statusHistory.push({ status: 'cancelled', changedAt: new Date() });
  await reservation.save();
  await ReservationSlot.deleteMany({ reservationId: reservation._id });
  await safelyNotify(notifyManagers(reservation.restaurantId || RESTAURANT_ID, { type: 'reservation', title: 'Reservation cancelled', message: `Table request ${String(reservation._id).slice(-6).toUpperCase()} was cancelled by the customer.`, href: '/manager', eventKey: `reservation:${String(reservation._id)}:status:cancelled` }));
  return response.json({ message: 'Reservation cancelled.', id: String(reservation._id), status: reservation.status });
});

api.get('/payments/config', (_request, response) => {
  const mode = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET ? 'razorpay' : DEMO_ONLINE_PAYMENTS ? 'demo' : null;
  return response.json({
    onlinePaymentsEnabled: Boolean(mode),
    mode,
    keyId: mode === 'razorpay' ? RAZORPAY_KEY_ID : null,
    currency: PAYMENT_CURRENCY,
    deliveryFeeCents: DELIVERY_FEE_CENTS,
  });
});

api.post('/orders', formLimiter, requireOrderAccount, async (request, response) => {
  const input = orderSchema.parse(request.body);
  const userId = getSessionUserId(request)!;
  let addressSnapshot = input.deliveryAddressSnapshot;
  if (input.addressId) {
    const savedAddress = await CustomerAddress.findOne({ _id: input.addressId, userId }).lean();
    if (!savedAddress) return response.status(404).json({ error: 'Choose a delivery address saved to your account.' });
    addressSnapshot = {
      label: savedAddress.label as 'Home' | 'Work' | 'Other',
      recipientName: savedAddress.recipientName,
      phone: savedAddress.phone,
      house: savedAddress.house,
      locality: savedAddress.locality,
      landmark: savedAddress.landmark || '',
      city: savedAddress.city,
      state: savedAddress.state,
      pincode: savedAddress.pincode,
      instructions: savedAddress.instructions || '',
    };
  }
  const address = addressSnapshot ? formatDeliveryAddress(addressSnapshot) : input.address;
  if (!address || address.trim().length < 8) return response.status(400).json({ error: 'Enter your full delivery address, including area and city.' });
  const customerName = addressSnapshot?.recipientName || input.name;
  const customerPhone = addressSnapshot?.phone || input.phone;
  const deliveryInstructions = addressSnapshot?.instructions || input.deliveryInstructions;
  const onlinePayment = input.paymentMethod !== 'cash_on_delivery';
  const demoPayment = input.paymentMethod === 'demo_online';
  if (demoPayment && !DEMO_ONLINE_PAYMENTS) {
    return response.status(503).json({ error: 'Demo online payments are disabled. Choose cash on delivery or configure the restaurant payment gateway.' });
  }
  if (input.paymentMethod === 'razorpay' && (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)) {
    return response.status(503).json({ error: 'Online payments are not configured yet. Choose cash on delivery or contact the restaurant.' });
  }

  const quantityById = new Map<string, number>();
  for (const item of input.items) {
    const totalQuantity = (quantityById.get(item.id) || 0) + item.quantity;
    if (totalQuantity > 10) return response.status(400).json({ error: 'An item quantity cannot exceed 10.' });
    quantityById.set(item.id, totalQuantity);
  }

  const products = await Product.find({ id: { $in: [...quantityById.keys()] }, active: true }).lean();
  const productById = new Map(products.map((product) => [product.id, product]));
  if (productById.size !== quantityById.size) {
    return response.status(400).json({ error: 'A menu item in your bag is no longer available.' });
  }

  const items = [...quantityById.entries()].map(([id, quantity]) => {
    const product = productById.get(id)!;
    return { productId: product.id, name: product.name, quantity, priceCents: product.priceCents };
  });
  const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents + taxCents + DELIVERY_FEE_CENTS;
  const trackingToken = randomBytes(32).toString('base64url');
  const demoPaymentToken = demoPayment ? randomBytes(32).toString('base64url') : undefined;
  const order = await Order.create({
    customerName,
    email: input.email,
    phone: customerPhone,
    address,
    deliveryAddressSnapshot: addressSnapshot,
    deliveryInstructions,
    paymentMethod: input.paymentMethod,
    paymentStatus: onlinePayment ? 'pending' : 'unpaid',
    paymentProvider: input.paymentMethod === 'razorpay' ? 'razorpay' : demoPayment ? 'demo' : undefined,
    demoPaymentTokenHash: demoPaymentToken ? createHash('sha256').update(demoPaymentToken).digest('hex') : undefined,
    status: onlinePayment ? 'awaiting_payment' : 'pending',
    items,
    subtotalCents,
    taxCents,
    deliveryFeeCents: DELIVERY_FEE_CENTS,
    totalCents,
    currency: PAYMENT_CURRENCY,
    trackingTokenHash: createHash('sha256').update(trackingToken).digest('hex'),
    userId,
    restaurantId: RESTAURANT_ID,
    statusHistory: [{ status: onlinePayment ? 'awaiting_payment' : 'pending', changedAt: new Date() }],
  });
  if (order.status === 'pending') await safelyNotify(notifyOrderPlaced(order));

  let payment: { provider: 'razorpay'; keyId: string; gatewayOrderId: string; amount: number; currency: string } | { provider: 'demo'; demoPaymentToken: string; amount: number; currency: string } | undefined;
  if (demoPayment && demoPaymentToken) {
    payment = { provider: 'demo', demoPaymentToken, amount: totalCents, currency: PAYMENT_CURRENCY };
  } else if (input.paymentMethod === 'razorpay') {
    try {
      const gatewayOrder = await razorpayRequest<RazorpayGatewayOrder>('/orders', 'POST', {
        amount: totalCents,
        currency: PAYMENT_CURRENCY,
        receipt: String(order._id),
        notes: { restaurant_order_id: String(order._id) },
      });
      if (gatewayOrder.amount !== totalCents || gatewayOrder.currency !== PAYMENT_CURRENCY) {
        throw new Error('The payment service returned an unexpected amount or currency.');
      }
      order.razorpayOrderId = gatewayOrder.id;
      await order.save();
      payment = { provider: 'razorpay', keyId: RAZORPAY_KEY_ID!, gatewayOrderId: gatewayOrder.id, amount: totalCents, currency: PAYMENT_CURRENCY };
    } catch (error) {
      order.status = 'cancelled';
      order.paymentStatus = 'failed';
      await order.save();
      return response.status(502).json({ error: error instanceof Error ? error.message : 'The online payment could not be started.' });
    }
  }

  return response.status(201).json({
    message: demoPayment ? 'Demo checkout is ready. No real payment will be charged.' : onlinePayment ? 'Your order is ready for secure online payment.' : 'Your delivery order has been received. Pay cash when it arrives.',
    order: {
      id: String(order._id),
      trackingToken,
      items,
      subtotalCents,
      taxCents,
      deliveryFeeCents: DELIVERY_FEE_CENTS,
      totalCents,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: input.paymentMethod,
      currency: PAYMENT_CURRENCY,
    },
    ...(payment ? { payment } : {}),
  });
});

api.post('/orders/:id/complete-demo-payment', formLimiter, async (request, response) => {
  if (!DEMO_ONLINE_PAYMENTS) return response.status(404).json({ error: 'Demo payment is not available.' });
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid order.' });
  const input = z.object({ token: z.string().min(20).max(128) }).parse(request.body);
  const order = await Order.findById(request.params.id).select('+demoPaymentTokenHash');
  if (!order || order.paymentMethod !== 'demo_online' || !order.demoPaymentTokenHash) {
    return response.status(404).json({ error: 'The demo payment could not be found.' });
  }
  const submittedHash = createHash('sha256').update(input.token).digest();
  const savedHash = Buffer.from(order.demoPaymentTokenHash, 'hex');
  if (savedHash.length !== submittedHash.length || !timingSafeEqual(savedHash, submittedHash)) {
    return response.status(403).json({ error: 'The demo payment token is invalid.' });
  }
  if (order.paymentStatus === 'paid') {
    return response.json({ message: 'Demo payment is complete. No money was charged.', order: { id: String(order._id), status: order.status, paymentStatus: order.paymentStatus } });
  }
  if (order.paymentStatus !== 'pending' || order.status !== 'awaiting_payment') {
    return response.status(409).json({ error: 'This order is no longer waiting for demo payment.' });
  }
  order.paymentStatus = 'paid';
  order.status = 'pending';
  order.statusHistory.push({ status: 'pending', changedAt: new Date() });
  await order.save();
  await safelyNotify(notifyOrderPlaced(order));
  return response.json({
    message: 'Demo payment complete. No money was charged. Your order has been sent to the restaurant.',
    order: { id: String(order._id), status: order.status, paymentStatus: order.paymentStatus },
  });
});

api.post('/orders/:id/verify-payment', formLimiter, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid order.' });
  const input = paymentVerificationSchema.parse(request.body);
  const order = await Order.findById(request.params.id).select('+trackingTokenHash');
  if (!order || order.paymentMethod !== 'razorpay' || !order.razorpayOrderId) {
    return response.status(404).json({ error: 'The online order could not be found.' });
  }
  if (order.paymentStatus === 'paid' && order.razorpayPaymentId === input.razorpayPaymentId) {
    return response.json({ message: 'Your payment is confirmed.', order: { id: String(order._id), status: order.status, paymentStatus: order.paymentStatus, totalCents: order.totalCents } });
  }
  if (order.razorpayOrderId !== input.razorpayOrderId) return response.status(400).json({ error: 'The payment does not match this order.' });

  const expectedSignature = createHmac('sha256', RAZORPAY_KEY_SECRET || '')
    .update(`${order.razorpayOrderId}|${input.razorpayPaymentId}`).digest();
  const submittedSignature = Buffer.from(input.razorpaySignature, 'hex');
  if (expectedSignature.length !== submittedSignature.length || !timingSafeEqual(expectedSignature, submittedSignature)) {
    return response.status(400).json({ error: 'The payment could not be verified. Your order has not been marked paid.' });
  }

  let payment = await razorpayRequest<RazorpayGatewayPayment>(`/payments/${encodeURIComponent(input.razorpayPaymentId)}`, 'GET');
  if (payment.order_id !== order.razorpayOrderId || payment.amount !== order.totalCents || payment.currency !== order.currency) {
    return response.status(400).json({ error: 'The payment details do not match this order.' });
  }
  if (payment.status === 'authorized') {
    await razorpayRequest<RazorpayGatewayPayment>(`/payments/${encodeURIComponent(input.razorpayPaymentId)}/capture`, 'POST', {
      amount: order.totalCents,
      currency: order.currency,
    });
    payment = await razorpayRequest<RazorpayGatewayPayment>(`/payments/${encodeURIComponent(input.razorpayPaymentId)}`, 'GET');
  }
  if (payment.status !== 'captured') {
    return response.status(409).json({ error: 'Payment has not been captured yet. The order is still awaiting payment confirmation.' });
  }

  // Conditional writes so a webhook, status poll, cancellation, or staff update made during the gateway calls is not overwritten.
  const refundPendingOrder = await Order.findOneAndUpdate(
    { _id: order._id, status: 'cancelled', paymentStatus: 'pending' },
    { $set: { paymentStatus: 'refund_pending', razorpayPaymentId: payment.id } },
    { new: true },
  );
  if (refundPendingOrder) await safelyNotify(notifyRefundPending(refundPendingOrder));
  const placedOrder = refundPendingOrder ? null : await Order.findOneAndUpdate(
    { _id: order._id, status: 'awaiting_payment', paymentStatus: 'pending' },
    { $set: { paymentStatus: 'paid', status: 'pending', razorpayPaymentId: payment.id }, $push: { statusHistory: { status: 'pending', changedAt: new Date() } } },
    { new: true },
  );
  if (placedOrder) await safelyNotify(notifyOrderPlaced(placedOrder));
  if (!refundPendingOrder && !placedOrder) {
    await Order.updateOne({ _id: order._id, paymentStatus: 'pending', status: { $nin: ['awaiting_payment', 'cancelled'] } }, { $set: { paymentStatus: 'paid', razorpayPaymentId: payment.id } });
  }

  const current = await Order.findById(order._id).select('status paymentStatus totalCents').lean();
  if (!current) return response.status(404).json({ error: 'The online order could not be found.' });
  const summary = { id: String(current._id), status: current.status, paymentStatus: current.paymentStatus, totalCents: current.totalCents };
  if (current.paymentStatus === 'refund_pending') {
    return response.json({ message: 'Payment was captured after cancellation. A refund is pending manual processing by the restaurant.', order: summary });
  }
  if (current.paymentStatus !== 'paid') {
    return response.status(409).json({ error: 'The order is no longer awaiting payment.' });
  }
  return response.json({
    message: 'Payment confirmed. Your delivery order has been sent to the restaurant.',
    order: summary,
  });
});

api.get('/orders/:id/status', orderStatusLimiter, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'Order status could not be found.' });
  const { token } = orderTrackingSchema.parse(request.query);
  const trackingTokenHash = createHash('sha256').update(token).digest('hex');
  const order = await Order.findOne({ _id: request.params.id, trackingTokenHash }).select('status paymentStatus paymentMethod totalCents currency razorpayOrderId').lean();
  if (!order) return response.status(404).json({ error: 'Order status could not be found.' });
  let status = order.status || 'pending';
  let paymentStatus = order.paymentStatus || 'unpaid';
  if (paymentStatus === 'pending' && order.paymentMethod === 'razorpay' && order.razorpayOrderId && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
    try {
      const gatewayOrder = await razorpayRequest<RazorpayGatewayOrder>(`/orders/${encodeURIComponent(order.razorpayOrderId)}`, 'GET');
      if (gatewayOrder.status === 'paid' && gatewayOrder.amount_paid === order.totalCents && gatewayOrder.currency === (order.currency || 'INR')) {
        // Match the status read above so a cancellation made meanwhile is not undone.
        if (status === 'cancelled') {
          const result = await Order.updateOne({ _id: order._id, paymentStatus: 'pending', status: 'cancelled' }, { $set: { paymentStatus: 'refund_pending' } });
          if (result.modifiedCount) {
            paymentStatus = 'refund_pending';
            await safelyNotify(notifyRefundPending(order));
          }
        } else {
          const nextStatus = status === 'awaiting_payment' ? 'pending' : status;
          const result = await Order.updateOne({ _id: order._id, paymentStatus: 'pending', status }, {
            $set: { paymentStatus: 'paid', status: nextStatus },
            ...(nextStatus !== status ? { $push: { statusHistory: { status: nextStatus, changedAt: new Date() } } } : {}),
          });
          if (result.modifiedCount) {
            if (nextStatus !== status) await safelyNotify(notifyOrderPlaced(order));
            status = nextStatus;
            paymentStatus = 'paid';
          }
        }
      }
    } catch { /* The status page can retry if the gateway is temporarily unavailable. */ }
  }
  return response.json({
    status,
    paymentStatus,
    paymentMethod: order.paymentMethod,
    totalCents: order.totalCents,
    currency: order.currency || 'INR',
  });
});

api.get('/admin/managers', requireAdmin, async (_request, response) => {
  const managers = await User.find({ role: 'manager' }).select('name email username restaurantId active mustChangePassword createdAt').sort({ createdAt: -1 }).lean();
  return response.json({ managers: managers.map((manager) => ({
    id: String(manager._id), name: manager.name, email: manager.email, username: manager.username || '',
    restaurantId: manager.restaurantId || RESTAURANT_ID, active: manager.active !== false,
    mustChangePassword: Boolean(manager.mustChangePassword), createdAt: manager.createdAt,
  })) });
});

api.post('/admin/managers', requireAdmin, async (request, response) => {
  const input = managerCreateSchema.parse(request.body);
  const temporaryPassword = randomBytes(18).toString('base64url');
  const manager = await User.create({
    name: input.name, email: input.email, username: input.username,
    passwordHash: await bcrypt.hash(temporaryPassword, 12), role: 'manager',
    restaurantId: RESTAURANT_ID, active: true, mustChangePassword: true,
  });
  await recordStaffAction(request, 'admin', 'manager_created', 'manager', String(manager._id), RESTAURANT_ID, { username: manager.username });
  return response.status(201).json({
    message: 'Manager account created. Share the temporary password securely; it is shown only once.',
    manager: { id: String(manager._id), name: manager.name, email: manager.email, username: manager.username, restaurantId: RESTAURANT_ID, active: true },
    temporaryPassword,
  });
});

api.patch('/admin/managers/:id', requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That manager account could not be found.' });
  const { active } = z.object({ active: z.boolean() }).parse(request.body);
  const manager = await User.findOneAndUpdate({ _id: request.params.id, role: 'manager' }, { $set: { active } }, { new: true }).select('name email username active restaurantId');
  if (!manager) return response.status(404).json({ error: 'That manager account could not be found.' });
  await recordStaffAction(request, 'admin', active ? 'manager_reactivated' : 'manager_suspended', 'manager', String(manager._id), manager.restaurantId || RESTAURANT_ID);
  return response.json({ message: active ? 'Manager account reactivated.' : 'Manager account suspended.', manager: { id: String(manager._id), name: manager.name, email: manager.email, username: manager.username, active: manager.active, restaurantId: manager.restaurantId || RESTAURANT_ID } });
});

api.post('/admin/managers/:id/reset-password', requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That manager account could not be found.' });
  const manager = await User.findOne({ _id: request.params.id, role: 'manager' });
  if (!manager) return response.status(404).json({ error: 'That manager account could not be found.' });
  const temporaryPassword = randomBytes(18).toString('base64url');
  manager.passwordHash = await bcrypt.hash(temporaryPassword, 12);
  manager.mustChangePassword = true;
  await manager.save();
  await recordStaffAction(request, 'admin', 'manager_password_reset', 'manager', String(manager._id), manager.restaurantId || RESTAURANT_ID);
  return response.json({ message: 'Temporary password reset. It is shown only once.', temporaryPassword });
});

api.get('/admin/audit-logs', requireAdmin, async (request, response) => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit ?? 50);
  const entries = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).populate({ path: 'actorId', select: 'name username' }).lean();
  return response.json({ entries: entries.map((entry) => {
    const actor = entry.actorId as unknown as { _id?: unknown; name?: string; username?: string } | null;
    return { id: String(entry._id), actorName: actor?.name || actor?.username || 'Staff account', actorRole: entry.actorRole, action: entry.action, resourceType: entry.resourceType, resourceId: entry.resourceId, restaurantId: entry.restaurantId || null, details: entry.details || {}, createdAt: entry.createdAt };
  }) });
});

api.get('/manager/dashboard', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  const restaurantId = manager?.restaurantId;
  if (!restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const [orders, reservations, orderCount, pendingOrderCount, reservationCount, pendingReservationCount, paidOrders] = await Promise.all([
    Order.find({ restaurantId }).sort({ createdAt: -1 }).limit(200).select('customerName email phone address deliveryInstructions paymentMethod paymentStatus items subtotalCents taxCents deliveryFeeCents totalCents currency status createdAt').lean(),
    Reservation.find({ restaurantId }).sort({ createdAt: -1 }).limit(200).select('name email phone date time guests tableId currency items preorderTotalCents status specialRequests createdAt').lean(),
    Order.countDocuments({ restaurantId }),
    Order.countDocuments({ restaurantId, status: { $in: ['pending', 'awaiting_payment'] } }),
    Reservation.countDocuments({ restaurantId }),
    Reservation.countDocuments({ restaurantId, status: 'pending' }),
    Order.aggregate([{ $match: { restaurantId, paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$totalCents' } } }]),
  ]);
  return response.json({
    restaurant: { id: restaurantId, name: restaurantNameFor(restaurantId) },
    stats: { orderCount, pendingOrderCount, reservationCount, pendingReservationCount, verifiedSalesCents: paidOrders[0]?.total || 0 },
    orders: orders.map((order) => ({ id: String(order._id), customerName: order.customerName, email: order.email, phone: order.phone, address: order.address, deliveryInstructions: order.deliveryInstructions || '', paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus || 'unpaid', items: order.items || [], subtotalCents: order.subtotalCents, taxCents: order.taxCents, deliveryFeeCents: order.deliveryFeeCents || 0, totalCents: order.totalCents, currency: order.currency || 'INR', status: order.status || 'pending', createdAt: order.createdAt })),
    reservations: reservations.map((reservation) => ({ id: String(reservation._id), name: reservation.name, restaurantName: restaurantNameFor(restaurantId), email: reservation.email, phone: reservation.phone, date: reservation.date, time: reservation.time, guests: reservation.guests, tableId: reservation.tableId || 'Table not assigned', currency: reservation.currency || 'INR', items: reservation.items || [], preorderTotalCents: reservation.preorderTotalCents || 0, status: reservation.status || 'pending', specialRequests: reservation.specialRequests || '', createdAt: reservation.createdAt })),
  });
});

api.get('/manager/menu', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const products = await Product.find({ restaurantId: manager.restaurantId }).sort({ displayOrder: 1 }).lean();
  return response.json({ products });
});

api.post('/manager/menu', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const input = z.object({
    name: z.string().trim().min(1).max(100), category: z.enum(['Appetizers', 'Biryani', 'Entrees', 'Desserts']),
    description: z.string().trim().min(1).max(500), priceCents: z.coerce.number().int().min(1).max(10000000),
    isVegetarian: z.boolean().default(false), imageUrl: z.union([z.literal(''), z.string().url().max(1000).refine((url) => url.startsWith('https://'), 'Use an HTTPS image URL.')]).default(''),
  }).parse(request.body);
  const baseId = input.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'menu-item';
  let id = baseId;
  let suffix = 2;
  // Product IDs are unique across all restaurants, not only this one.
  while (await Product.exists({ id })) id = `${baseId}-${suffix++}`;
  const nextOrder = await Product.countDocuments({ restaurantId: manager.restaurantId });
  const product = await Product.create({ ...input, id, restaurantId: manager.restaurantId, displayOrder: nextOrder + 1, emoji: input.isVegetarian ? '🥬' : '🍽️', active: true });
  await recordStaffAction(request, 'manager', 'menu_item_created', 'menu_item', product.id, manager.restaurantId, { category: product.category, isVegetarian: product.isVegetarian });
  return response.status(201).json({ message: 'Menu item added.', product: product.toObject() });
});

api.patch('/manager/menu/:id', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const input = z.object({
    name: z.string().trim().min(1).max(100).optional(), category: z.enum(['Appetizers', 'Biryani', 'Entrees', 'Desserts']).optional(),
    description: z.string().trim().min(1).max(500).optional(), priceCents: z.number().int().min(1).max(10000000).optional(),
    active: z.boolean().optional(), isVegetarian: z.boolean().optional(),
    imageUrl: z.union([z.literal(''), z.string().url().max(1000).refine((url) => url.startsWith('https://'), 'Use an HTTPS image URL.')]).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'Choose at least one menu field to update.').parse(request.body);
  const product = await Product.findOneAndUpdate({ id: request.params.id, restaurantId: manager.restaurantId }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!product) return response.status(404).json({ error: 'That menu item could not be found in your restaurant.' });
  await recordStaffAction(request, 'manager', 'menu_item_updated', 'menu_item', product.id, manager.restaurantId, { changedFields: Object.keys(input) });
  return response.json({ message: 'Menu item updated.', product });
});

api.delete('/manager/menu/:id', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const product = await Product.findOneAndUpdate({ id: request.params.id, restaurantId: manager.restaurantId }, { $set: { active: false } }, { new: true }).select('id active').lean();
  if (!product) return response.status(404).json({ error: 'That menu item could not be found in your restaurant.' });
  await recordStaffAction(request, 'manager', 'menu_item_removed', 'menu_item', product.id, manager.restaurantId);
  return response.json({ message: 'Menu item removed from the active menu. Order history remains intact.' });
});

api.get('/manager/tables', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const tables = await DiningTable.find({ restaurantId: manager.restaurantId }).sort({ section: 1, row: 1, column: 1 }).lean();
  return response.json({ tables });
});

api.post('/manager/tables', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const input = z.object({ section: z.enum(['A', 'B', 'C']), seats: z.coerce.number().int().min(1).max(8), row: z.coerce.number().int().min(1).max(2), column: z.coerce.number().int().min(1).max(2) }).parse(request.body);
  const existingIds = await DiningTable.find({ restaurantId: manager.restaurantId }).select('id').lean();
  // Table IDs are unique across all restaurants, so use the same per-restaurant prefix as the seeded tables.
  const restaurantIndex = RESTAURANTS.findIndex((restaurant) => restaurant.id === manager.restaurantId);
  const idPrefix = restaurantIndex > 0 ? `V${String(restaurantIndex + 1).padStart(2, '0')}-T` : 'T';
  const nextNumber = existingIds.reduce((max, table) => table.id.startsWith(idPrefix) ? Math.max(max, Number(table.id.slice(idPrefix.length)) || 0) : max, 0) + 1;
  const table = await DiningTable.create({ id: `${idPrefix}${String(nextNumber).padStart(2, '0')}`, ...input, restaurantId: manager.restaurantId, active: true });
  await recordStaffAction(request, 'manager', 'table_created', 'table', table.id, manager.restaurantId, { seats: table.seats, section: table.section });
  return response.status(201).json({ message: 'Table added.', table: table.toObject() });
});

api.patch('/manager/tables/:id', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const input = z.object({ seats: z.coerce.number().int().min(1).max(8).optional(), active: z.boolean().optional(), section: z.enum(['A', 'B', 'C']).optional(), row: z.coerce.number().int().min(1).max(2).optional(), column: z.coerce.number().int().min(1).max(2).optional() }).strict().refine((value) => Object.keys(value).length > 0, 'Choose a table setting to update.').parse(request.body);
  if (input.active === false) {
    const futureReservations = await Reservation.find({ restaurantId: manager.restaurantId, tableId: request.params.id, status: { $in: ['pending', 'confirmed', 'seated'] } }).select('date time startsAt endsAt').lean();
    if (futureReservations.some((reservation) => reservationTimesOverlap(reservation, new Date(), new Date(Date.now() + 90 * 86400000)))) return response.status(409).json({ error: 'This table has upcoming reservations and cannot be disabled yet.' });
  }
  if (input.seats !== undefined) {
    const existingReservations = await Reservation.find({ restaurantId: manager.restaurantId, tableId: request.params.id, status: { $in: ['pending', 'confirmed', 'seated'] } }).select('date time startsAt endsAt guests').lean();
    if (existingReservations.some((reservation) => reservation.guests > input.seats! && reservationTimesOverlap(reservation, new Date(), new Date(Date.now() + 90 * 86400000)))) {
      return response.status(409).json({ error: 'This table has future requests for larger parties. Cancel or move those requests before reducing its capacity.' });
    }
  }
  const table = await DiningTable.findOneAndUpdate({ id: request.params.id, restaurantId: manager.restaurantId }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!table) return response.status(404).json({ error: 'That table could not be found in your restaurant.' });
  await recordStaffAction(request, 'manager', 'table_updated', 'table', table.id, manager.restaurantId, { changedFields: Object.keys(input) });
  return response.json({ message: 'Table settings updated.', table });
});

api.delete('/manager/tables/:id', requireManager, async (request, response) => {
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const futureReservations = await Reservation.find({ restaurantId: manager.restaurantId, tableId: request.params.id, status: { $in: ['pending', 'confirmed', 'seated'] } }).select('date time startsAt endsAt').lean();
  const future = futureReservations.some((reservation) => reservationTimesOverlap(reservation, new Date(), new Date(Date.now() + 90 * 86400000)));
  if (future) return response.status(409).json({ error: 'This table has upcoming reservations and cannot be disabled yet.' });
  const table = await DiningTable.findOneAndUpdate({ id: request.params.id, restaurantId: manager.restaurantId }, { $set: { active: false } }, { new: true }).lean();
  if (!table) return response.status(404).json({ error: 'That table could not be found in your restaurant.' });
  await recordStaffAction(request, 'manager', 'table_disabled', 'table', table.id, manager.restaurantId);
  return response.json({ message: 'Table disabled. Its reservation history remains saved.' });
});

api.patch('/manager/orders/:id/status', requireManager, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid order.' });
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const { status } = orderStatusSchema.parse(request.body);
  const current = await Order.findOne({ _id: request.params.id, restaurantId: manager.restaurantId });
  if (!current) return response.status(404).json({ error: 'That order could not be found in your restaurant.' });
  if (!canTransitionOrder(current.status, status)) return response.status(409).json({ error: `Order status cannot move from ${current.status} to ${status}.` });
  if (['razorpay', 'demo_online'].includes(current.paymentMethod) && current.paymentStatus !== 'paid' && status !== 'cancelled') return response.status(409).json({ error: 'Confirm the online payment before preparing or dispatching this order.' });
  current.status = status;
  if (current.paymentMethod === 'razorpay' && current.paymentStatus === 'paid' && ['rejected', 'cancelled'].includes(status)) current.paymentStatus = 'refund_pending';
  current.statusHistory.push({ status, changedAt: new Date() });
  await current.save();
  await safelyNotify(notifyOrderStatus(current, status));
  if (current.paymentStatus === 'refund_pending') await safelyNotify(notifyRefundPending(current));
  await recordStaffAction(request, 'manager', 'order_status_changed', 'order', String(current._id), manager.restaurantId, { status });
  return response.json({ message: 'Order status updated.', id: String(current._id), status: current.status });
});

api.patch('/manager/reservations/:id/status', requireManager, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid reservation.' });
  const manager = await User.findById(getSessionUserId(request)).select('restaurantId').lean();
  if (!manager?.restaurantId) return response.status(403).json({ error: 'This manager account is not assigned to a restaurant.' });
  const { status } = reservationStatusSchema.parse(request.body);
  const current = await Reservation.findOne({ _id: request.params.id, restaurantId: manager.restaurantId });
  if (!current) return response.status(404).json({ error: 'That reservation could not be found in your restaurant.' });
  if (!canTransitionReservation(current.status, status)) return response.status(409).json({ error: `Reservation status cannot move from ${current.status} to ${status}.` });
  if (status === 'confirmed') {
    const table = await DiningTable.findOne({ id: current.tableId, restaurantId: manager.restaurantId, active: true }).lean();
    if (!table || table.seats < current.guests) return response.status(409).json({ error: 'The assigned table is inactive or no longer fits this party.' });
    const range = current.startsAt && current.endsAt ? { startsAt: current.startsAt, endsAt: current.endsAt } : reservationRange(current.date, current.time);
    const otherReservations = await Reservation.find({ restaurantId: manager.restaurantId, tableId: current.tableId, status: { $in: ['pending', 'confirmed', 'seated'] }, _id: { $ne: current._id } }).select('date time startsAt endsAt').lean();
    if (otherReservations.some((reservation) => reservationTimesOverlap(reservation, range.startsAt, range.endsAt))) return response.status(409).json({ error: 'That table overlaps another active reservation. Review the request before confirming it.' });
  }
  current.status = status;
  current.statusHistory.push({ status, changedAt: new Date() });
  await current.save();
  if (status === 'rejected' || status === 'cancelled' || status === 'completed') await ReservationSlot.deleteMany({ reservationId: current._id });
  await safelyNotify(notifyReservationStatus(current, status));
  await recordStaffAction(request, 'manager', 'reservation_status_changed', 'reservation', String(current._id), manager.restaurantId, { status });
  return response.json({ message: status === 'confirmed' ? `Reservation confirmed for ${current.tableId}.` : `Reservation ${status}.`, id: String(current._id), status: current.status, tableId: current.tableId });
});

api.get('/admin/dashboard', requireAdmin, async (_request, response) => {
  const [orders, reservations, orderCount, pendingOrderCount, reservationCount, pendingReservationCount] = await Promise.all([
    Order.find().sort({ createdAt: -1 })
      .select('customerName email phone address deliveryInstructions paymentMethod paymentStatus items subtotalCents taxCents deliveryFeeCents totalCents currency status createdAt').lean(),
    Reservation.find().sort({ createdAt: -1 }).limit(100)
      .select('name email phone date time guests tableId restaurantId currency items preorderTotalCents status createdAt').lean(),
    Order.countDocuments(),
    Order.countDocuments({ status: { $in: ['pending', 'awaiting_payment'] } }),
    Reservation.countDocuments(),
    Reservation.countDocuments({ status: 'pending' }),
  ]);

  return response.json({
    stats: { orderCount, pendingOrderCount, reservationCount, pendingReservationCount },
    orders: orders.map((order) => ({
      id: String(order._id),
      customerName: order.customerName,
      email: order.email,
      phone: order.phone,
      address: order.address,
      deliveryInstructions: order.deliveryInstructions || '',
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus || 'unpaid',
      items: order.items || [],
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      deliveryFeeCents: order.deliveryFeeCents || 0,
      totalCents: order.totalCents,
      currency: order.currency || 'INR',
      status: order.status || 'pending',
      createdAt: order.createdAt,
    })),
    reservations: reservations.map((reservation) => ({
      id: String(reservation._id),
      name: reservation.name,
      email: reservation.email,
      phone: reservation.phone,
      date: reservation.date,
      time: reservation.time,
      guests: reservation.guests,
      restaurantName: restaurantNameFor(reservation.restaurantId || RESTAURANT_ID),
      tableId: reservation.tableId || 'Table not assigned',
      currency: reservation.currency || 'INR',
      items: reservation.items || [],
      preorderTotalCents: reservation.preorderTotalCents || 0,
      status: reservation.status || 'pending',
      createdAt: reservation.createdAt,
    })),
  });
});

api.get('/account/orders', requireOrderAccess, async (request, response) => {
  const userId = getSessionUserId(request);
  const user = await User.findById(userId).select('role').lean();
  const isAdmin = user?.role === 'admin';
  const orders = await Order.find(isAdmin ? {} : { userId }).sort({ createdAt: -1 })
    .select('customerName email address deliveryInstructions paymentMethod paymentStatus items subtotalCents taxCents deliveryFeeCents totalCents currency status statusHistory createdAt').lean();
  return response.json({
    orders: orders.map((order) => ({
      id: String(order._id),
      ...(isAdmin ? { customerName: order.customerName, email: order.email } : {}),
      address: order.address,
      deliveryInstructions: order.deliveryInstructions || '',
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus || 'unpaid',
      items: order.items || [],
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      deliveryFeeCents: order.deliveryFeeCents || 0,
      totalCents: order.totalCents,
      currency: order.currency || 'INR',
      status: order.status || 'pending',
      statusHistory: order.statusHistory || [],
      createdAt: order.createdAt,
    })),
  });
});

api.post('/account/orders/:id/cancel', requireCustomer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That order could not be found.' });
  const order = await Order.findOne({ _id: request.params.id, userId: getSessionUserId(request) });
  if (!order) return response.status(404).json({ error: 'That order could not be found in your account.' });
  if (!['awaiting_payment', 'pending'].includes(order.status)) return response.status(409).json({ error: 'This order can no longer be cancelled from your account.' });
  order.status = 'cancelled';
  if (order.paymentMethod === 'razorpay' && order.paymentStatus === 'paid') order.paymentStatus = 'refund_pending';
  order.statusHistory.push({ status: 'cancelled', changedAt: new Date() });
  await order.save();
  await safelyNotify(notifyOrderStatus(order, 'cancelled'));
  if (order.paymentStatus === 'refund_pending') await safelyNotify(notifyRefundPending(order));
  await safelyNotify(notifyManagers(order.restaurantId || RESTAURANT_ID, { type: 'order', title: 'Order cancelled', message: `Order ${String(order._id).slice(-6).toUpperCase()} was cancelled by the customer.`, href: '/manager', eventKey: `order:${String(order._id)}:status:cancelled` }));
  return response.json({ message: order.paymentStatus === 'refund_pending' ? 'Order cancelled. A refund is pending manual processing by the restaurant.' : 'Order cancelled.', id: String(order._id), status: order.status, paymentStatus: order.paymentStatus });
});

api.get('/account/orders/:id', requireOrderAccess, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ error: 'That order could not be found.' });
  const userId = getSessionUserId(request);
  const user = await User.findById(userId).select('role').lean();
  const isAdmin = user?.role === 'admin';
  const order = await Order.findOne(isAdmin ? { _id: request.params.id } : { _id: request.params.id, userId })
    .select('customerName email address deliveryInstructions paymentMethod paymentStatus items subtotalCents taxCents deliveryFeeCents totalCents currency status statusHistory createdAt').lean();
  if (!order) return response.status(404).json({ error: 'That order could not be found in your account.' });
  return response.json({
    order: {
      id: String(order._id),
      ...(isAdmin ? { customerName: order.customerName, email: order.email } : {}),
      address: order.address,
      deliveryInstructions: order.deliveryInstructions || '',
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus || 'unpaid',
      items: order.items || [],
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      deliveryFeeCents: order.deliveryFeeCents || 0,
      totalCents: order.totalCents,
      currency: order.currency || 'INR',
      status: order.status || 'pending',
      statusHistory: order.statusHistory || [],
      createdAt: order.createdAt,
    },
  });
});

api.patch('/admin/orders/:id/status', requireAdmin, async (request, response) => {
  const { status } = orderStatusSchema.parse(request.body);
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid order.' });
  const current = await Order.findById(request.params.id).select('paymentMethod paymentStatus status');
  if (!current) return response.status(404).json({ error: 'That order could not be found.' });
  if (current.status === status) return response.json({ message: 'Order already has that status.', id: String(current._id), status: current.status });
  if (!canTransitionOrder(current.status, status)) return response.status(409).json({ error: `Order status cannot move from ${current.status} to ${status}.` });
  if (['razorpay', 'demo_online'].includes(current.paymentMethod) && current.paymentStatus !== 'paid' && status !== 'cancelled' && status !== 'awaiting_payment') {
    return response.status(409).json({ error: 'Confirm the online payment before preparing or dispatching this order.' });
  }
  const order = await Order.findById(request.params.id);
  if (!order) return response.status(404).json({ error: 'That order could not be found.' });
  order.status = status;
  if (order.paymentMethod === 'razorpay' && order.paymentStatus === 'paid' && ['rejected', 'cancelled'].includes(status)) order.paymentStatus = 'refund_pending';
  order.statusHistory.push({ status, changedAt: new Date() });
  await order.save();
  await safelyNotify(notifyOrderStatus(order, status));
  if (order.paymentStatus === 'refund_pending') await safelyNotify(notifyRefundPending(order));
  await recordStaffAction(request, 'admin', 'order_status_changed', 'order', String(order._id), order.restaurantId, { status });
  return response.json({ message: 'Order status updated.', id: String(order._id), status: order.status });
});

api.patch('/admin/reservations/:id/status', requireAdmin, async (request, response) => {
  const { status } = reservationStatusSchema.parse(request.body);
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: 'Choose a valid reservation.' });
  const current = await Reservation.findById(request.params.id);
  if (!current) return response.status(404).json({ error: 'That reservation could not be found.' });
  if (current.status === status) return response.json({ message: 'Reservation already has that status.', id: String(current._id), status: current.status, tableId: current.tableId });
  if (!canTransitionReservation(current.status, status)) return response.status(409).json({ error: `Reservation status cannot move from ${current.status} to ${status}.` });

  if (status === 'confirmed' || status === 'seated') {
    if (!current.tableId) return response.status(409).json({ error: 'This request has no table number assigned and cannot be approved.' });
    const range = current.startsAt && current.endsAt ? { startsAt: current.startsAt, endsAt: current.endsAt } : reservationRange(current.date, current.time);
    const [table, conflictingReservations] = await Promise.all([
      DiningTable.findOne({ id: current.tableId, restaurantId: current.restaurantId || RESTAURANT_ID, active: true }).select('id seats').lean(),
      Reservation.find({ restaurantId: current.restaurantId || RESTAURANT_ID, tableId: current.tableId, status: { $in: ['pending', 'confirmed', 'seated'] }, _id: { $ne: current._id } }).select('date time startsAt endsAt').lean(),
    ]);
    if (!table || table.seats < current.guests || conflictingReservations.some((reservation) => reservationTimesOverlap(reservation, range.startsAt, range.endsAt))) return response.status(409).json({ error: `Table ${current.tableId} is no longer available for this time. Review the request before approving it.` });
  }
  current.status = status;
  current.statusHistory.push({ status, changedAt: new Date() });
  try { await current.save(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return response.status(409).json({ error: `Table ${current.tableId || ''} is no longer available for this time. Review the request before approving it.` });
    throw error;
  }
  if (status === 'rejected' || status === 'cancelled' || status === 'completed') await ReservationSlot.deleteMany({ reservationId: current._id });
  await safelyNotify(notifyReservationStatus(current, status));
  await recordStaffAction(request, 'admin', 'reservation_status_changed', 'reservation', String(current._id), current.restaurantId || RESTAURANT_ID, { status });
  const message = status === 'confirmed' ? `Reservation approved for table ${current.tableId}.` : `Reservation ${status}.`;
  return response.json({ message, id: String(current._id), status: current.status, tableId: current.tableId });
});

api.use((_request, response) => response.status(404).json({ error: 'API route not found.' }));

app.use('/api', (request, response, next) => {
  response.header('Access-Control-Allow-Credentials', 'true');
  response.header('Vary', 'Origin');
  if (request.headers.origin && !CLIENT_ORIGINS.has(request.headers.origin)) {
    return response.status(403).json({ error: 'This request was not accepted.' });
  }
  return next();
});

// Public menu reads come from the database so manager edits are visible immediately.
app.get('/api/menu', async (_request, response, next) => {
  try {
    const products = await Product.find({ restaurantId: RESTAURANT_ID, active: true }).sort({ displayOrder: 1 }).lean();
    return response.json({ products, taxRate: TAX_RATE });
  } catch (error) { return next(error); }
});

let localMongo: { getUri: (databaseName?: string) => string; stop: () => Promise<boolean> } | undefined;

async function start(): Promise<void> {
  let mongoUri = MONGODB_URI;
  if (!mongoUri && process.env.NODE_ENV !== 'production') {
    const { MongoMemoryServer } = await import('mongodb-memory-server-core');
    const mongoDataDirectory = path.join(tmpdir(), 'juniper-table-mongodb');
    const mongoBinaryDirectory = path.resolve(currentDirectory, '../../node_modules/.cache/mongodb-memory-server');
    await mkdir(mongoDataDirectory, { recursive: true });
    localMongo = await MongoMemoryServer.create({
      binary: { downloadDir: mongoBinaryDirectory },
      instance: {
        ip: '127.0.0.1',
        dbName: 'juniper_table',
        dbPath: mongoDataDirectory,
        storageEngine: 'wiredTiger',
      },
    });
    mongoUri = localMongo.getUri('juniper_table');
    console.log('Started local MongoDB with persistent data at ' + mongoDataDirectory);
  }
  if (!mongoUri) throw new Error('MONGODB_URI is required in production.');
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const adminConfigCount = [ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD].filter(Boolean).length;
  if (adminConfigCount !== 0 && adminConfigCount !== 3) throw new Error('Set ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD together to configure administrator access.');
  if (ADMIN_USERNAME && !/^[a-z0-9._-]{3,32}$/.test(ADMIN_USERNAME)) throw new Error('ADMIN_USERNAME must be 3–32 letters, numbers, dots, underscores, or hyphens.');
  if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 8) throw new Error('ADMIN_PASSWORD must contain at least 8 characters.');
  if (Boolean(RAZORPAY_KEY_ID) !== Boolean(RAZORPAY_KEY_SECRET)) throw new Error('Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable online payments.');
  if (process.env.DEMO_ONLINE_PAYMENTS?.trim().toLowerCase() === 'true' && process.env.NODE_ENV === 'production') throw new Error('Demo online payments cannot be enabled in production.');
  if (PAYMENT_CURRENCY !== 'INR') throw new Error('PAYMENT_CURRENCY must match the current INR menu prices.');
  if (!Number.isSafeInteger(DELIVERY_FEE_CENTS) || DELIVERY_FEE_CENTS < 0) throw new Error('DELIVERY_FEE_CENTS must be a non-negative whole number.');

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  // Customer accounts created before role-based access was added can have no role field.
  // Staff accounts always have a username, so only backfill legacy non-staff accounts.
  await User.updateMany({ role: null, username: null }, { $set: { role: 'customer' } });
  await User.updateMany({ role: 'admin', name: 'Juniper Table Admin' }, { $set: { name: 'Foodie Table Admin' } });
  if (ADMIN_USERNAME && ADMIN_EMAIL && ADMIN_PASSWORD) {
    const existingEmailOwner = await User.findOne({ email: ADMIN_EMAIL }).select('role').lean();
    if (existingEmailOwner?.role === 'customer') {
      console.error('Administrator setup skipped to protect an existing customer account. Configure a separate administrator email.');
    } else {
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await User.updateOne(
        { email: ADMIN_EMAIL },
        { $set: { role: 'admin', username: ADMIN_USERNAME, passwordHash }, $setOnInsert: { name: 'Foodie Table Admin' } },
        { upsert: true },
      );
      console.log('Administrator account is ready for username ' + ADMIN_USERNAME + '.');
    }
  } else {
    console.log('Admin portal locked. Set ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD in .env to enable it.');
  }

  await Order.updateMany({ status: { $exists: false } }, { $set: { status: 'pending' } });
  await Order.updateMany({ restaurantId: { $exists: false } }, { $set: { restaurantId: RESTAURANT_ID } });
  const ordersWithoutStatusHistory = await Order.find({ statusHistory: { $exists: false } }).select('status createdAt');
  for (const order of ordersWithoutStatusHistory) {
    order.statusHistory = [{ status: order.status || 'pending', changedAt: order.createdAt || new Date() }];
    await order.save();
  }
  await Order.updateMany({ paymentStatus: { $exists: false } }, { $set: { paymentStatus: 'unpaid' } });
  await Order.updateMany({ deliveryFeeCents: { $exists: false } }, { $set: { deliveryFeeCents: 0 } });
  await Order.updateMany({ currency: { $exists: false } }, { $set: { currency: 'USD' } });
  await Reservation.updateMany({ status: { $exists: false } }, { $set: { status: 'pending' } });
  await Reservation.updateMany({ restaurantId: { $exists: false } }, { $set: { restaurantId: RESTAURANT_ID } });
  await DiningTable.updateMany({ restaurantId: { $exists: false } }, { $set: { restaurantId: RESTAURANT_ID } });
  await Product.updateMany({ restaurantId: { $exists: false } }, { $set: { restaurantId: RESTAURANT_ID } });
  const rupeePricesByProductId = new Map(MENU.map((product) => [product.id, product.priceCents]));
  const legacyOrders = await Order.find({ currency: 'USD', paymentMethod: { $ne: 'razorpay' } });
  for (const order of legacyOrders) {
    for (const item of order.items) {
      item.priceCents = rupeePricesByProductId.get(item.productId) ?? Math.round(item.priceCents * 95);
    }
    let orderSubtotalCents = 0;
    for (const item of order.items) orderSubtotalCents += item.priceCents * item.quantity;
    order.subtotalCents = orderSubtotalCents;
    order.taxCents = Math.round(order.subtotalCents * TAX_RATE);
    order.deliveryFeeCents = Math.round(order.deliveryFeeCents * 95);
    order.totalCents = order.subtotalCents + order.taxCents + order.deliveryFeeCents;
    order.currency = 'INR';
    await order.save();
  }
  const legacyReservations = await Reservation.find({ currency: { $exists: false } });
  for (const reservation of legacyReservations) {
    for (const item of reservation.items) {
      item.priceCents = rupeePricesByProductId.get(item.productId) ?? Math.round(item.priceCents * 95);
    }
    let preorderTotalCents = 0;
    for (const item of reservation.items) preorderTotalCents += item.priceCents * item.quantity;
    reservation.preorderTotalCents = preorderTotalCents;
    reservation.currency = 'INR';
    await reservation.save();
  }
  const reservationIndexes = await Reservation.collection.indexes().catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 26) return [];
    throw error;
  });
  const priorTableSlotIndex = reservationIndexes.find((index) => index.name === 'date_1_time_1_tableId_1');
  if (priorTableSlotIndex) await Reservation.collection.dropIndex(priorTableSlotIndex.name!);

  await Product.bulkWrite(MENU.map((product) => ({
    updateOne: { filter: { id: product.id }, update: { $setOnInsert: { ...product, restaurantId: RESTAURANT_ID, isVegetarian: ['spring-rolls', 'edamame', 'vegetable-biryani', 'veggie-burger', 'cheesecake', 'lava-cake', 'fruit-salad'].includes(product.id) } }, upsert: true },
  })));
  await DiningTable.bulkWrite(DINING_TABLES.map((table) => ({
    updateOne: { filter: { id: table.id }, update: { $setOnInsert: table }, upsert: true },
  })));
  await Promise.all([User.init(), Product.init(), Order.init(), Reservation.init(), DiningTable.init(), CustomerAddress.init(), ReservationSlot.init(), Notification.init(), AuditLog.init()]);

  const reservationsToLock = await Reservation.find({ tableId: { $type: 'string' }, status: { $in: ['pending', 'confirmed', 'seated'] } }).sort({ createdAt: 1 });
  for (const reservation of reservationsToLock) {
    const range = reservation.startsAt && reservation.endsAt ? { startsAt: reservation.startsAt, endsAt: reservation.endsAt } : reservationRange(reservation.date, reservation.time);
    if (!reservation.startsAt || !reservation.endsAt) { reservation.startsAt = range.startsAt; reservation.endsAt = range.endsAt; await reservation.save(); }
    try {
      await ReservationSlot.insertMany(reservationSlotStarts(range.startsAt, range.endsAt).map((slotStart) => ({ tableId: reservation.tableId!, slotStart, reservationId: reservation._id })), { ordered: false });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000) && !(error && typeof error === 'object' && 'writeErrors' in error)) throw error;
    }
  }

  const sessionStore = MongoStore.create({
    mongoUrl: mongoUri,
    collectionName: 'sessions',
    ttl: 24 * 60 * 60,
  });
  app.use('/api', session({
    name: SESSION_COOKIE,
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    },
  }), api);

  const clientBuild = path.resolve(currentDirectory, '../../client/dist');
  if (existsSync(clientBuild)) {
    app.use(express.static(clientBuild, { index: false }));
    app.get(/.*/, (_request, response, next) => {
      response.sendFile(path.join(clientBuild, 'index.html'), (error) => error && next(error));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({ error: error.issues[0]?.message || 'Please check the submitted information.' });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      if ('keyPattern' in error && error.keyPattern && typeof error.keyPattern === 'object' && 'tableId' in error.keyPattern) {
        return response.status(409).json({ error: 'That table was just requested for this time. Choose another table or time.' });
      }
      if ('keyPattern' in error && error.keyPattern && typeof error.keyPattern === 'object' && 'email' in error.keyPattern) {
        return response.status(409).json({ error: 'An account with this email already exists.' });
      }
      return response.status(409).json({ error: 'That item already exists. Use a different name or ID and try again.' });
    }
    console.error('Request failed:', error instanceof Error ? error.message : 'Unknown server error');
    return response.status(500).json({ error: 'The request could not be completed.' });
  });
}

appReady = start();

if (process.env.VERCEL !== '1') {
  void appReady.then(() => {
    const listenHost = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
    const httpServer = app.listen(PORT, listenHost, () => {
      console.log('API ready at http://127.0.0.1:' + PORT);
      console.log('MongoDB connected. Menu seed is available in the products collection.');
    });

    const shutdown = () => {
      httpServer.close(() => {
        void mongoose.disconnect().finally(() => localMongo?.stop()).finally(() => process.exit(0));
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error: unknown) => {
    console.error('The API could not start:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
} else {
  void appReady.catch((error: unknown) => {
    console.error('The API could not start:', error instanceof Error ? error.message : error);
  });
}

export default app;
