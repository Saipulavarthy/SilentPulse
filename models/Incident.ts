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
    /** Optional — phone may omit GPS. */
    gps: { type: GpsSchema, required: false },
    lowBandwidth: { type: Boolean, default: false },
    classificationFailed: { type: Boolean, default: false },
    victimInstructions: { type: String, required: true },
    /** ICE snapshot used for this SOS (phone and/or Mongo merge). */
    iceProfile: { type: IncidentIceSnapshotSchema, default: null },
    /** Victim quick-action selection from the phone crisis UI. */
    userProvidedContext: { type: String, default: null },
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

export const ActiveIncident: Model<IActiveIncident> =
  mongoose.models.ActiveIncident ||
  mongoose.model<IActiveIncident>("ActiveIncident", ActiveIncidentSchema);
