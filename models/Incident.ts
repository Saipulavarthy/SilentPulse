import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const CRISIS_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
  "UNKNOWN",
] as const;

export type CrisisType = (typeof CRISIS_TYPES)[number];

export const INCIDENT_STATUSES = [
  "ACTIVE",
  "ACKNOWLEDGED",
  "RESOLVED",
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const TRENDS = ["new", "worsening", "stable", "improving"] as const;

export type Trend = (typeof TRENDS)[number];

const GpsSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    /** Horizontal accuracy radius in metres (Geolocation coords.accuracy). */
    accuracy: { type: Number },
    /** Altitude in metres when the device reports it. */
    altitude: { type: Number },
  },
  { _id: false },
);

const BuildingSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    floors: { type: Number, required: true },
    notes: { type: String },
  },
  { _id: false },
);

const IncidentIceSnapshotSchema = new Schema(
  {
    name: { type: String },
    age: { type: Number },
    bloodType: { type: String },
    allergies: { type: [String], default: [] },
    conditions: { type: [String], default: [] },
    medications: { type: [String], default: [] },
    emergencyContact: {
      name: { type: String },
      phone: { type: String },
      relation: { type: String },
    },
    mobilityNotes: { type: String },
    sensoryNotes: { type: String },
  },
  { _id: false },
);

const TimelineEntrySchema = new Schema(
  {
    ts: { type: Date, required: true },
    crisisType: { type: String, enum: CRISIS_TYPES, required: true },
    severityScore: { type: Number, min: 1, max: 10, required: true },
    gps: {
      type: new Schema(
        {
          lat: { type: Number, required: true },
          lng: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    lowBandwidth: { type: Boolean, default: false },
    classificationFailed: { type: Boolean, default: false },
    sceneSummary: { type: String },
  },
  { _id: false },
);

const DispatcherMessageSchema = new Schema(
  {
    text: { type: String, required: true },
    sentAt: { type: Date, required: true },
    seenAt: { type: Date },
  },
  { _id: false },
);

/** One dispatcher-triggered call to the emergency contact. `to` is the last 4 digits only. */
const ContactCallSchema = new Schema(
  {
    kind: { type: String, enum: ["alert", "allClear"], required: true },
    status: { type: String, required: true },
    to: { type: String, required: true },
    script: { type: String, required: true },
    spoken: { type: String, enum: ["script", "trialTemplate"] },
    callSid: { type: String, default: "" },
    requestedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    answeredAt: { type: Date },
  },
  { _id: false },
);

const ActiveIncidentSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    /** Phone continuous-telemetry session; upserts reuse the same incident. */
    sessionId: { type: String, index: true, unique: true, sparse: true },
    crisisType: {
      type: String,
      enum: CRISIS_TYPES,
      required: true,
    },
    severityScore: {
      type: Number,
      min: 1,
      max: 10,
      required: true,
    },
    dispatcherBrief: { type: String, required: true },
    sceneSummary: { type: String },
    cues: { type: [String], default: [] },
    reasons: { type: [String], default: [] },
    trend: {
      type: String,
      enum: TRENDS,
      default: "new",
    },
    /** Optional — phone may omit GPS. */
    gps: { type: GpsSchema, required: false },
    /** Resolved UMass building from GPS (null when outside campus footprints). */
    building: { type: BuildingSchema, default: null },
    lowBandwidth: { type: Boolean, default: false },
    classificationFailed: { type: Boolean, default: false },
    simulated: { type: Boolean, default: false },
    /** AI-generated steps (string[]) or legacy static string. */
    victimInstructions: { type: Schema.Types.Mixed, required: true },
    /** ICE snapshot used for this SOS (phone and/or Mongo merge). */
    iceProfile: { type: IncidentIceSnapshotSchema, default: null },
    lastSeenAt: { type: Date },
    /** True when a live session stopped updating past SIGNAL_LOSS_MS. */
    escalated: { type: Boolean, default: false },
    escalationReason: { type: String },
    updateCount: { type: Number, default: 1 },
    timeline: { type: [TimelineEntrySchema], default: [] },
    /** Victim quick-action selection from the phone crisis UI. */
    userProvidedContext: { type: String, default: null },
    /** Live text from the dispatcher shown on the caller's phone. */
    dispatcherMessage: { type: DispatcherMessageSchema, default: null },
    /** Calls to the emergency contact; absent until the first one. */
    contactCalls: { type: [ContactCallSchema], default: undefined },
    status: {
      type: String,
      enum: INCIDENT_STATUSES,
      default: "ACTIVE",
    },
  },
  { timestamps: true },
);

export type IActiveIncident = InferSchemaType<typeof ActiveIncidentSchema> & {
  _id: mongoose.Types.ObjectId;
};

export type ActiveIncidentDocument = mongoose.HydratedDocument<IActiveIncident>;

// Drop stale compiled model so new fields (timeline, simulated, …) register in dev.
if (mongoose.models.ActiveIncident) {
  delete mongoose.models.ActiveIncident;
}

export const ActiveIncident: Model<IActiveIncident> =
  mongoose.model<IActiveIncident>("ActiveIncident", ActiveIncidentSchema);
