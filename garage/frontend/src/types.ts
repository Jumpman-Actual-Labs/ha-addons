export type VehicleStatus = "active" | "stored" | "sold" | "project";
export type FuelType = "gasoline" | "diesel" | "electric" | "hybrid" | "flex";
export type FuelGrade = "regular" | "midgrade" | "premium" | "diesel" | "electric";
export type PaymentMethod = "cash" | "credit_card" | "debit_card" | "other";
export type MaintenanceBasis = "mileage" | "time" | "both";
export type MaintenancePerformedBy = "diy" | "shop";
export type DocumentCategory = "registration" | "insurance" | "receipt" | "photo" | "other";
export type Drivetrain = "fwd" | "rwd" | "awd" | "4wd";
export type WheelPosition = "front_left" | "front_right" | "rear_left" | "rear_right";

/** What the backend's last poll of a linked HA sensor found (obd.py). */
export interface LiveSensorStatus {
  entity_id: string;
  status: "ok" | "unavailable" | "missing" | "parked" | string;
  state: string | null;
  unit: string;
  read_at: string;
}

export interface Vehicle {
  entityId: string;
  vehicleId: string;
  nickname: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  drivetrain: Drivetrain;
  status: VehicleStatus;
  currentMileage: number;
  currentFuelPct: number | null;
  fuelType: FuelType;
  vin: string;
  licensePlate: string;
  titleNumber?: string;
  color: string;
  tankCapacityGal: number | null;
  oilCapacityQt: number | null;
  tireSize: string;
  notes: string;
  photoPath: string | null;
  primaryDriverId: string | null;
  additionalDriverIds: string[];
  odometerEntityId: string;
  fuelLevelEntityId: string;
  liveSensors: { odometer?: LiveSensorStatus; fuel?: LiveSensorStatus };
  registrationExpires: string | null;
  insuranceExpires: string | null;
  healthScore: number;
  healthDeductions: HealthDeduction[];
  averageMpg: number | null;
  averagePricePerGallon: number | null;
  estimatedRangeMiles: number | null;
  lifetimeFuelCost: number;
  lifetimeMaintenanceCost: number;
  monthlyFuelCost: number;
  monthlyMaintenanceCost: number;
  nextMaintenanceDue: MaintenanceDueStatus | null;
  maintenanceDueCount: number;
  maintenanceDueSoonCount: number;
  lastFuelDate: string | null;
  lastMaintenanceDate: string | null;
}

export interface MaintenanceDueStatus {
  template_id: string;
  name: string;
  due: boolean;
  due_soon: boolean;
  due_at_mileage: number | null;
  due_at_date: string | null;
  miles_remaining: number | null;
  days_remaining: number | null;
}

export interface Driver {
  id: string;
  name: string;
  haUserId: string | null;
  notifyTarget: string | null;
}

export interface FuelEntry {
  id: string;
  vehicleId: string;
  date: string;
  odometer: number;
  amountDollars: number;
  fuelGrade: FuelGrade;
  station: string;
  paymentMethod: PaymentMethod;
  fullTank: boolean;
  notes: string;
  gallonsAdded: number | null;
  pricePerGallon: number | null;
  mpg: number | null;
}

export interface MaintenanceTemplate {
  id: string;
  name: string;
  basis: MaintenanceBasis;
  intervalMiles: number | null;
  intervalMonths: number | null;
  isCustom: boolean;
}

export interface MaintenanceRecord {
  id: string;
  vehicleId: string;
  templateId: string | null;
  name: string;
  date: string;
  odometer: number;
  cost: number;
  partsCost: number;
  laborCost: number;
  performedBy: MaintenancePerformedBy;
  shopName: string;
  wheelPositions: WheelPosition[];
  notes: string;
}

export interface GarageDocument {
  id: string;
  vehicleId: string;
  category: DocumentCategory;
  filename: string;
  path: string;
  uploadedAt: string;
}

export interface GarageState {
  vehicles: Vehicle[];
  drivers: Driver[];
  fuelEntries: FuelEntry[];
  maintenanceTemplates: MaintenanceTemplate[];
  maintenanceRecords: MaintenanceRecord[];
  documents: GarageDocument[];
  totalMonthlyFuelSpend: number;
  totalMonthlyMaintenanceSpend: number;
  vehiclesNeedingAttention: string[];
  settings: {
    lowFuelThreshold: number;
    financeSyncEnabled: boolean;
    financeCategoryName: string;
  };
}

export interface HealthDeduction {
  reason: string;
  points: number;
}
