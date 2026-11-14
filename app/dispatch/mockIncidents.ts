import { VICTIM_INSTRUCTIONS, statusToDispatcherStatus, type Incident } from '@/types/incident';

// MOCK DATA: every person, user ID, phone number, medical detail and event below is
// fictional. Phone numbers use the reserved 555-01xx range. GPS points sit inside the
// real building footprints (OpenStreetMap). groundElevationM values are USGS ground
// elevations; altitude and accuracy readings are invented, in the same datum.
// Timestamps are relative to module load so the feed always looks like the last 10 minutes.

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const tick = (m: number, severityScore: number, crisisType: Incident['crisisType'], extra: { lowBandwidth?: boolean; sceneSummary?: string } = {}) => ({
  ts: minsAgo(m),
  crisisType,
  severityScore,
  gps: null,
  lowBandwidth: extra.lowBandwidth ?? false,
  classificationFailed: false,
  sceneSummary: extra.sceneSummary,
});

type MockInput = Omit<Incident, 'victimInstructions' | 'dispatcherStatus'>;

const base: MockInput[] = [
  {
    _id: 'mock-001',
    userId: 'user-ajames',
    crisisType: 'ACTIVE_THREAT',
    severityScore: 9,
    dispatcherBrief:
      'Caller reports armed individual inside Du Bois Library. Caller is hiding, silent. Dispatch UMPD immediately; approach from stairwells.',
    sceneSummary: 'Whispered audio: "he has a gun"; footsteps and shouting in background.',
    cues: ['whispered speech', 'footsteps approaching', 'shouting in background'],
    reasons: [
      'Caller reports armed individual → risk of imminent violence',
      'Caller hiding and whispering → cannot speak freely',
      'Footsteps approaching on the last update → threat may be near the caller',
    ],
    trend: 'worsening',
    timeline: [
      tick(3, 7, 'ACTIVE_THREAT', { sceneSummary: 'Muffled shouting, caller breathing quickly.' }),
      tick(1.5, 8, 'ACTIVE_THREAT', { sceneSummary: 'Whispered audio: "he has a gun".' }),
      tick(0.5, 9, 'ACTIVE_THREAT', { sceneSummary: 'Whispered audio; footsteps approaching.' }),
    ],
    updateCount: 3,
    lastSeenAt: minsAgo(0.5),
    gps: { lat: 42.38973, lng: -72.52825, accuracy: 12, altitude: 130 },
    building: {
      name: 'W.E.B. Du Bois Library',
      type: 'Library',
      floors: 28,
      notes: 'Elevators only stop on alternate floors above 4. Two stairwells.',
      groundElevationM: 72,
    },
    iceProfile: {
      name: 'Avery James',
      age: 20,
      conditions: ['Asthma'],
      allergies: [],
      medications: ['Albuterol inhaler'],
      emergencyContact: { name: 'Dana James', phone: '413-555-0101' },
    },
    lowBandwidth: false,
    status: 'ACTIVE',
    createdAt: minsAgo(3),
    updatedAt: minsAgo(0.5),
  },
  {
    // Second caller in the same building as mock-001: exercises shared-building badges.
    _id: 'mock-009',
    userId: 'user-rwalsh',
    crisisType: 'MEDICAL_CRISIS',
    severityScore: 8,
    dispatcherBrief:
      'Caller reports a person injured while fleeing inside Du Bois Library; heavy bleeding from a leg wound. Stage EMS until the scene is secured.',
    sceneSummary: 'Audio: caller breathing heavily, says "someone is bleeding"; alarm in background.',
    cues: ['heavy breathing', '"someone is bleeding"', 'alarm tone'],
    reasons: ['Heavy bleeding from a leg wound → risk of severe blood loss'],
    trend: 'new',
    gps: { lat: 42.38965, lng: -72.52832, accuracy: 15, altitude: 81 },
    building: {
      name: 'W.E.B. Du Bois Library',
      type: 'Library',
      floors: 28,
      notes: 'Elevators only stop on alternate floors above 4. Two stairwells.',
      groundElevationM: 72,
    },
    iceProfile: {
      name: 'Riley Walsh',
      age: 21,
      conditions: [],
      allergies: ['Ibuprofen'],
      medications: [],
      emergencyContact: { name: 'Morgan Walsh', phone: '413-555-0109' },
    },
    lowBandwidth: false,
    status: 'ACTIVE',
    createdAt: minsAgo(0.3),
    updatedAt: minsAgo(0.3),
  },
  {
    _id: 'mock-002',
    userId: 'user-mokafor',
    crisisType: 'MEDICAL_CRISIS',
    severityScore: 8,
    dispatcherBrief:
      'Male collapsed on basketball court, unresponsive, bystander starting CPR. Possible cardiac arrest. Send ALS; AED is at the front desk.',
    sceneSummary: 'Image shows person on gym floor, bystanders kneeling beside him.',
    cues: ['person lying motionless on court', 'bystander doing chest compressions', 'second bystander running toward lobby'],
    reasons: [
      'Unresponsive with CPR in progress → possible cardiac arrest',
      'Bystander heading to lobby → AED may already be on its way',
    ],
    trend: 'stable',
    timeline: [
      tick(1.5, 8, 'MEDICAL_CRISIS', { sceneSummary: 'Person collapsed on gym floor.' }),
      tick(0.8, 8, 'MEDICAL_CRISIS', { sceneSummary: 'Bystander doing compressions.' }),
    ],
    updateCount: 2,
    lastSeenAt: minsAgo(0.8),
    // Altitude without groundElevationM: no floor estimate should be shown.
    gps: { lat: 42.38886, lng: -72.53167, accuracy: 8, altitude: 66 },
    building: {
      name: 'Recreation Center',
      type: 'Athletics',
      floors: 3,
      notes: 'Main entrance faces Southwest. AED at front desk.',
    },
    iceProfile: {
      name: 'Marcus Okafor',
      age: 22,
      conditions: ['Hypertrophic cardiomyopathy'],
      allergies: ['Penicillin'],
      medications: ['Metoprolol'],
      emergencyContact: { name: 'Grace Okafor', phone: '413-555-0102' },
    },
    lowBandwidth: false,
    status: 'ACTIVE',
    createdAt: minsAgo(1.5),
    updatedAt: minsAgo(1.5),
  },
  {
    _id: 'mock-003',
    userId: 'user-pnair',
    crisisType: 'ENVIRONMENTAL_HAZARD',
    severityScore: 7,
    dispatcherBrief:
      'Strong chemical odor and visible vapor in 7th-floor lab corridor. Caller reports dizziness. Notify Amherst FD hazmat and EH&S; evacuate floors 6-8.',
    sceneSummary: 'Image shows haze in hallway; audio has fire alarm sounding.',
    gps: { lat: 42.39391, lng: -72.52766, accuracy: 18, altitude: 96 },
    building: {
      name: 'Lederle Graduate Research Tower',
      type: 'Research / Labs',
      floors: 16,
      notes: 'Chemistry labs on upper floors. Fume hood shutoffs per floor.',
      groundElevationM: 70.7,
    },
    iceProfile: {
      name: 'Priya Nair',
      age: 26,
      conditions: [],
      allergies: ['Latex'],
      medications: [],
      emergencyContact: { name: 'Ravi Nair', phone: '413-555-0103' },
    },
    lowBandwidth: false,
    status: 'ACKNOWLEDGED',
    createdAt: minsAgo(3),
    updatedAt: minsAgo(2),
  },
  {
    _id: 'mock-004',
    userId: 'user-lchen',
    crisisType: 'UNKNOWN',
    severityScore: 5,
    dispatcherBrief:
      'Low-bandwidth SOS: no image or audio received. Location only. Treat as unknown emergency; attempt callback and send unit to check.',
    trend: 'stable',
    timeline: [
      tick(4, 5, 'UNKNOWN', { lowBandwidth: true }),
      tick(3.3, 5, 'UNKNOWN', { lowBandwidth: true }),
      tick(2.6, 5, 'UNKNOWN', { lowBandwidth: true }),
    ],
    updateCount: 3,
    lastSeenAt: minsAgo(2.6),
    escalated: true,
    escalationReason: 'Signal lost: no telemetry for over 2 minutes after 3 updates',
    gps: { lat: 42.38158, lng: -72.52931, accuracy: 35, altitude: 99 },
    building: {
      name: 'Washington Hall',
      type: 'Residence Hall',
      floors: 22,
      notes: 'Southwest Residential Area. Card access only.',
      groundElevationM: 62,
    },
    iceProfile: {
      name: 'Lin Chen',
      age: 19,
      conditions: ['Type 1 diabetes'],
      allergies: [],
      medications: ['Insulin'],
      emergencyContact: { name: 'Wei Chen', phone: '413-555-0104' },
      mobilityNotes: 'Uses a manual wheelchair',
    },
    lowBandwidth: true,
    status: 'ACTIVE',
    createdAt: minsAgo(4),
    updatedAt: minsAgo(2.6),
  },
  {
    _id: 'mock-005',
    userId: 'user-srodriguez',
    crisisType: 'MEDICAL_CRISIS',
    severityScore: 6,
    dispatcherBrief:
      'Suspected allergic reaction after eating; lip swelling, hives, no airway compromise yet. Caller has an EpiPen. Send BLS.',
    sceneSummary: 'Audio: caller says "my lips are swelling"; dining hall noise.',
    gps: { lat: 42.39326, lng: -72.52511 },
    building: {
      name: 'Worcester Dining Commons',
      type: 'Dining Hall',
      floors: 2,
    },
    iceProfile: {
      name: 'Sofia Rodriguez',
      age: 18,
      conditions: [],
      allergies: ['Peanuts', 'Tree nuts'],
      medications: ['EpiPen (epinephrine auto-injector)'],
      emergencyContact: { name: 'Elena Rodriguez', phone: '413-555-0105' },
    },
    lowBandwidth: false,
    status: 'ACKNOWLEDGED',
    createdAt: minsAgo(5.5),
    updatedAt: minsAgo(4.5),
  },
  {
    _id: 'mock-006',
    userId: 'user-tbrooks',
    crisisType: 'ACTIVE_THREAT',
    severityScore: 4,
    dispatcherBrief:
      'Caller reports being followed by an unknown person between Morrill and the Campus Pond. No weapon seen. Caller is walking toward Student Union.',
    sceneSummary: 'Audio: caller describes a man in a dark hoodie following them.',
    gps: { lat: 42.38947, lng: -72.52434 },
    building: {
      name: 'Morrill Science Center',
      type: 'Academic / Labs',
      floors: 4,
    },
    iceProfile: {
      name: 'Taylor Brooks',
      age: 21,
      conditions: [],
      allergies: [],
      medications: [],
      emergencyContact: { name: 'Jordan Brooks', phone: '413-555-0106' },
    },
    lowBandwidth: false,
    status: 'ACTIVE',
    createdAt: minsAgo(6.5),
    updatedAt: minsAgo(6.5),
  },
  {
    _id: 'mock-007',
    userId: 'user-ekowalski',
    crisisType: 'ENVIRONMENTAL_HAZARD',
    severityScore: 3,
    dispatcherBrief:
      'Large tree limb down across the Campus Pond path, blocking foot traffic. No injuries. Notify Physical Plant.',
    sceneSummary: 'Image shows a fallen branch across a paved walkway by the pond.',
    gps: { lat: 42.38876, lng: -72.527, accuracy: 25 },
    iceProfile: {
      name: 'Emma Kowalski',
      conditions: [],
      allergies: [],
      medications: [],
      emergencyContact: { name: 'Piotr Kowalski', phone: '413-555-0107' },
    },
    lowBandwidth: false,
    status: 'ACTIVE',
    createdAt: minsAgo(8),
    updatedAt: minsAgo(8),
  },
  {
    _id: 'mock-008',
    userId: 'user-dpatel',
    crisisType: 'MEDICAL_CRISIS',
    severityScore: 2,
    dispatcherBrief:
      'Twisted ankle on ILC stairs. Conscious, able to bear partial weight. Wants a ride to University Health Services.',
    sceneSummary: 'Image shows swollen ankle; caller sitting on stairs.',
    gps: { lat: 42.39108, lng: -72.52593 },
    building: {
      name: 'Integrative Learning Center',
      type: 'Academic',
      floors: 4,
    },
    iceProfile: {
      name: 'Dev Patel',
      age: 23,
      conditions: [],
      allergies: ['Sulfa drugs'],
      medications: [],
      emergencyContact: { name: 'Anika Patel', phone: '413-555-0108' },
    },
    lowBandwidth: false,
    status: 'RESOLVED',
    createdAt: minsAgo(10),
    updatedAt: minsAgo(3.5),
  },
];

/** The main mock set, completed with the fields main's contract requires. */
export const mockIncidents: Incident[] = base.map((m) => ({
  ...m,
  victimInstructions: VICTIM_INSTRUCTIONS[m.crisisType],
  dispatcherStatus: statusToDispatcherStatus(m.status),
}));
