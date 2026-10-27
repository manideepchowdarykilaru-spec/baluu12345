import mongoose, { type InferSchemaType } from 'mongoose';

const { Schema, model, models } = mongoose;

const productSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, enum: ['Appetizers', 'Biryani', 'Entrees', 'Desserts'] },
    description: { type: String, required: true, trim: true },
    priceCents: { type: Number, required: true, min: 1 },
    emoji: { type: String, required: true },
    displayOrder: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true, index: true },
    restaurantId: { type: String, required: true, default: 'juniper-table', index: true },
    isVegetarian: { type: Boolean, default: false },
    imageUrl: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    phone: { type: String, trim: true, maxlength: 25 },
    username: { type: String, lowercase: true, trim: true, unique: true, sparse: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ['customer', 'manager', 'admin'], default: 'customer', index: true },
    restaurantId: { type: String, trim: true, default: undefined, index: true },
    active: { type: Boolean, default: true, index: true },
    mustChangePassword: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const orderItemSchema = new Schema(
  {
    productId: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1, max: 10 },
    priceCents: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const orderStatusHistorySchema = new Schema(
  {
    status: { type: String, required: true, enum: ['awaiting_payment', 'pending', 'confirmed', 'rejected', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'completed', 'cancelled'] },
    changedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const reservationStatusHistorySchema = new Schema(
  {
    status: { type: String, required: true, enum: ['pending', 'confirmed', 'rejected', 'seated', 'completed', 'cancelled'] },
    changedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    customerName: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 25 },
    address: { type: String, required: true, trim: true, maxlength: 1000 },
    deliveryAddressSnapshot: {
      label: { type: String, enum: ['Home', 'Work', 'Other'] },
      recipientName: { type: String, trim: true, maxlength: 100 },
      phone: { type: String, trim: true, maxlength: 25 },
      house: { type: String, trim: true, maxlength: 120 },
      locality: { type: String, trim: true, maxlength: 160 },
      landmark: { type: String, trim: true, maxlength: 160 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      pincode: { type: String, trim: true, match: /^\d{6}$/ },
      instructions: { type: String, trim: true, maxlength: 500 },
    },
    deliveryInstructions: { type: String, trim: true, maxlength: 500, default: '' },
    paymentMethod: { type: String, required: true, enum: ['cash_on_delivery', 'razorpay', 'demo_online', 'cash', 'pay_at_restaurant'] },
    paymentStatus: { type: String, required: true, enum: ['unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded'], default: 'unpaid', index: true },
    paymentProvider: { type: String, enum: ['razorpay', 'demo'] },
    razorpayOrderId: { type: String, trim: true },
    razorpayPaymentId: { type: String, trim: true },
    demoPaymentTokenHash: { type: String, select: false },
    deliveryFeeCents: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, required: true, default: 'INR', enum: ['USD', 'INR'] },
    trackingTokenHash: { type: String, select: false },
    items: { type: [orderItemSchema], required: true },
    subtotalCents: { type: Number, required: true, min: 0 },
    taxCents: { type: Number, required: true, min: 0 },
    totalCents: { type: Number, required: true, min: 0 },
    status: { type: String, required: true, enum: ['awaiting_payment', 'pending', 'confirmed', 'rejected', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'completed', 'cancelled'], default: 'pending', index: true },
    statusHistory: { type: [orderStatusHistorySchema], default: [] },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    restaurantId: { type: String, required: true, default: 'juniper-table', index: true },
  },
  { timestamps: true },
);

const reservationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 25 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    guests: { type: Number, required: true, min: 1, max: 6 },
    tableId: { type: String, trim: true, index: true },
    currency: { type: String, required: true, default: 'INR', enum: ['USD', 'INR'] },
    status: { type: String, required: true, enum: ['pending', 'confirmed', 'rejected', 'seated', 'completed', 'cancelled'], default: 'pending', index: true },
    restaurantId: { type: String, required: true, default: 'juniper-table', index: true },
    specialRequests: { type: String, trim: true, maxlength: 500, default: '' },
    startsAt: { type: Date, index: true },
    endsAt: { type: Date, index: true },
    items: { type: [orderItemSchema], default: [] },
    preorderTotalCents: { type: Number, required: true, min: 0, default: 0 },
    trackingTokenHash: { type: String, select: false },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    statusHistory: { type: [reservationStatusHistorySchema], default: [] },
  },
  { timestamps: true },
);

reservationSchema.index(
  { date: 1, time: 1, tableId: 1 },
  { unique: true, partialFilterExpression: { tableId: { $type: 'string' }, status: { $in: ['pending', 'confirmed', 'seated'] } } },
);

const diningTableSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    section: { type: String, required: true, enum: ['A', 'B', 'C'] },
    seats: { type: Number, required: true, min: 1, max: 8 },
    row: { type: Number, required: true, min: 1, max: 2 },
    column: { type: Number, required: true, min: 1, max: 2 },
    active: { type: Boolean, default: true, index: true },
    restaurantId: { type: String, required: true, default: 'juniper-table', index: true },
  },
  { timestamps: true },
);

const customerAddressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, enum: ['Home', 'Work', 'Other'] },
    recipientName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 25 },
    house: { type: String, required: true, trim: true, maxlength: 120 },
    locality: { type: String, required: true, trim: true, maxlength: 160 },
    landmark: { type: String, trim: true, maxlength: 160, default: '' },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    pincode: { type: String, required: true, trim: true, match: /^\d{6}$/ },
    instructions: { type: String, trim: true, maxlength: 500, default: '' },
    isDefault: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
customerAddressSchema.index({ userId: 1, isDefault: -1, createdAt: -1 });

const reservationSlotSchema = new Schema({
  tableId: { type: String, required: true },
  slotStart: { type: Date, required: true },
  reservationId: { type: Schema.Types.ObjectId, ref: 'Reservation', required: true, index: true },
}, { timestamps: true });
reservationSlotSchema.index({ tableId: 1, slotStart: 1 }, { unique: true });

const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true, enum: ['order', 'reservation', 'account'] },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 300 },
  href: { type: String, required: true, trim: true, maxlength: 300 },
  dedupeKey: { type: String, trim: true, unique: true, sparse: true },
  readAt: { type: Date, default: null, index: true },
}, { timestamps: true });
notificationSchema.index({ userId: 1, createdAt: -1 });

const auditLogSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorRole: { type: String, required: true, enum: ['admin', 'manager'] },
  action: { type: String, required: true, trim: true, maxlength: 80 },
  resourceType: { type: String, required: true, trim: true, maxlength: 40 },
  resourceId: { type: String, required: true, trim: true, maxlength: 100 },
  restaurantId: { type: String, trim: true, maxlength: 100 },
  details: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ restaurantId: 1, createdAt: -1 });

const contactMessageSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

export type ProductRecord = InferSchemaType<typeof productSchema>;

export const Product = models.Product ?? model('Product', productSchema);
export const User = models.User ?? model('User', userSchema);
export const Order = models.Order ?? model('Order', orderSchema);
export const Reservation = models.Reservation ?? model('Reservation', reservationSchema);
export const DiningTable = models.DiningTable ?? model('DiningTable', diningTableSchema);
export const ContactMessage = models.ContactMessage ?? model('ContactMessage', contactMessageSchema);
export const CustomerAddress = models.CustomerAddress ?? model('CustomerAddress', customerAddressSchema);
export const ReservationSlot = models.ReservationSlot ?? model('ReservationSlot', reservationSlotSchema);
export const Notification = models.Notification ?? model('Notification', notificationSchema);
export const AuditLog = models.AuditLog ?? model('AuditLog', auditLogSchema);
