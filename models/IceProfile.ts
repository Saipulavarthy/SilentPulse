import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const EmergencyContactSchema = new Schema(
  {
    name: { type: String },
    phone: { type: String },
    relation: { type: String },
  },
  { _id: false },
);

const IceProfileSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    // Phone may send a partial profile — name is optional.
    name: { type: String },
    age: { type: Number },
    bloodType: { type: String },
    allergies: { type: [String], default: [] },
    conditions: { type: [String], default: [] },
    medications: { type: [String], default: [] },
    emergencyContact: { type: EmergencyContactSchema },
    mobilityNotes: { type: String },
    sensoryNotes: { type: String },
  },
  { timestamps: true },
);

export type IIceProfile = InferSchemaType<typeof IceProfileSchema> & {
  _id: mongoose.Types.ObjectId;
};

export type IceProfileDocument = mongoose.HydratedDocument<IIceProfile>;

export const IceProfile: Model<IIceProfile> =
  mongoose.models.IceProfile ||
  mongoose.model<IIceProfile>("IceProfile", IceProfileSchema);
