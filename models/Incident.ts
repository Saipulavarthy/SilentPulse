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
    lowBandwidth: { type: Boolean, default: false },
    classificationFailed: { type: Boolean, default: false },
    simulated: { type: Boolean, default: false },
    /** AI-generated steps (string[]) or legacy static string. */
    victimInstructions: { type: Schema.Types.Mixed, required: true },
    /** ICE snapshot used for this SOS (phone and/or Mongo merge). */
    iceProfile: { type: IncidentIceSnapshotSchema, default: null },
    lastSeenAt: { type: Date },
    updateCount: { type: Number, default: 1 },
    timeline: { type: [TimelineEntrySchema], default: [] },
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
