import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const CRISIS_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
  "LOW_BANDWIDTH_SOS",
] as const;

export type CrisisType = (typeof CRISIS_TYPES)[number];

export const INCIDENT_STATUSES = [
  "ACTIVE",
  "DISPATCHED",
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

const ActiveIncidentSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
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
    gps: { type: GpsSchema, required: true },
    isLowBandwidth: { type: Boolean, default: false },
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
