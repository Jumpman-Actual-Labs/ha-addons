import type {
  Driver,
  FuelEntry,
  GarageDocument,
  GarageState,
  MaintenanceRecord,
  MaintenanceTemplate,
  Vehicle,
} from "./types";

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface HassUser {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface FuelPhotoAnalysis {
  amount_dollars: number | null;
  gallons: number | null;
  price_per_gallon: number | null;
}

export interface VinDecodeResult {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  drivetrain: string | null;
  fuel_type: string | null;
  tank_capacity_gal: number | null;
  oil_capacity_qt: number | null;
}

/** The slice of Home Assistant's `hass` object the panel uses. In the
 * add-on it's implemented by addon-hass.ts against the add-on's backend. */
export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: HassUser;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>
  ): Promise<unknown>;
}

export interface HaUserSummary {
  id: string;
  name: string;
}

const DOMAIN = "garage";

function entitiesWith(hass: HomeAssistant, attr: string): HassEntity[] {
  // A second, Garage-specific attribute (garage_key, always present on our
  // own sensors) would be redundant here since every attribute name below
  // is specific enough on its own, but the vehicle sensor is the one place
  // multiple concepts share a lookup - filtered directly by garage_key value.
  return Object.values(hass.states).filter(
    (e) => e.entity_id.startsWith("sensor.") && attr in e.attributes
  );
}

function byGarageKey(hass: HomeAssistant, key: string): HassEntity | undefined {
  return entitiesWith(hass, "garage_key").find((e) => e.attributes.garage_key === key);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseFuelEntry(raw: Record<string, unknown>): FuelEntry {
  return {
    id: String(raw.id),
    vehicleId: String(raw.vehicle_id),
    date: String(raw.date ?? ""),
    odometer: num(raw.odometer),
    amountDollars: num(raw.amount_dollars),
    fuelGrade: (raw.fuel_grade as FuelEntry["fuelGrade"]) ?? "regular",
    station: String(raw.station ?? ""),
    paymentMethod: (raw.payment_method as FuelEntry["paymentMethod"]) ?? "credit_card",
    fullTank: Boolean(raw.full_tank),
    notes: String(raw.notes ?? ""),
    gallonsAdded: numOrNull(raw.gallons_added),
    pricePerGallon: numOrNull(raw.price_per_gallon),
    mpg: numOrNull(raw.mpg),
  };
}

function parseMaintenanceRecord(raw: Record<string, unknown>): MaintenanceRecord {
  return {
    id: String(raw.id),
    vehicleId: String(raw.vehicle_id),
    templateId: strOrNull(raw.template_id),
    name: String(raw.name ?? ""),
    date: String(raw.date ?? ""),
    odometer: num(raw.odometer),
    cost: num(raw.cost),
    partsCost: num(raw.parts_cost),
    laborCost: num(raw.labor_cost),
    performedBy: (raw.performed_by as MaintenanceRecord["performedBy"]) ?? "shop",
    shopName: String(raw.shop_name ?? ""),
    wheelPositions: Array.isArray(raw.wheel_positions)
      ? (raw.wheel_positions as MaintenanceRecord["wheelPositions"])
      : [],
    notes: String(raw.notes ?? ""),
  };
}

function parseDocument(raw: Record<string, unknown>): GarageDocument {
  return {
    id: String(raw.id),
    vehicleId: String(raw.vehicle_id),
    category: (raw.category as GarageDocument["category"]) ?? "other",
    filename: String(raw.filename ?? ""),
    path: String(raw.path ?? ""),
    uploadedAt: String(raw.uploaded_at ?? ""),
  };
}

export function parseGarageState(hass: HomeAssistant): GarageState {
  const vehicleEntities = entitiesWith(hass, "vehicle_id");

  const vehicles: Vehicle[] = vehicleEntities.map((e) => ({
    entityId: e.entity_id,
    vehicleId: String(e.attributes.vehicle_id),
    nickname: String(e.attributes.nickname ?? ""),
    year: num(e.attributes.year),
    make: String(e.attributes.make ?? ""),
    model: String(e.attributes.model ?? ""),
    trim: String(e.attributes.trim ?? ""),
    drivetrain: (e.attributes.drivetrain as Vehicle["drivetrain"]) ?? "fwd",
    status: (e.attributes.status as Vehicle["status"]) ?? "active",
    currentMileage: num(e.attributes.current_mileage),
    currentFuelPct: numOrNull(e.attributes.current_fuel_pct),
    fuelType: (e.attributes.fuel_type as Vehicle["fuelType"]) ?? "gasoline",
    vin: String(e.attributes.vin ?? ""),
    titleNumber: String(e.attributes.title_number ?? ""),
    licensePlate: String(e.attributes.license_plate ?? ""),
    color: String(e.attributes.color ?? ""),
    tankCapacityGal: numOrNull(e.attributes.tank_capacity_gal),
    oilCapacityQt: numOrNull(e.attributes.oil_capacity_qt),
    tireSize: String(e.attributes.tire_size ?? ""),
    notes: String(e.attributes.notes ?? ""),
    photoPath: strOrNull(e.attributes.photo_path),
    primaryDriverId: strOrNull(e.attributes.primary_driver_id),
    additionalDriverIds: Array.isArray(e.attributes.additional_driver_ids)
      ? (e.attributes.additional_driver_ids as string[])
      : [],
    registrationExpires: strOrNull(e.attributes.registration_expires),
    insuranceExpires: strOrNull(e.attributes.insurance_expires),
    healthScore: num(e.state),
    healthDeductions: Array.isArray(e.attributes.health_deductions)
      ? (e.attributes.health_deductions as Vehicle["healthDeductions"])
      : [],
    averageMpg: numOrNull(e.attributes.average_mpg),
    averagePricePerGallon: numOrNull(e.attributes.average_price_per_gallon),
    estimatedRangeMiles: numOrNull(e.attributes.estimated_range_miles),
    lifetimeFuelCost: num(e.attributes.lifetime_fuel_cost),
    lifetimeMaintenanceCost: num(e.attributes.lifetime_maintenance_cost),
    monthlyFuelCost: num(e.attributes.monthly_fuel_cost),
    monthlyMaintenanceCost: num(e.attributes.monthly_maintenance_cost),
    nextMaintenanceDue:
      (e.attributes.next_maintenance_due as Vehicle["nextMaintenanceDue"]) ?? null,
    maintenanceDueCount: num(e.attributes.maintenance_due_count),
    maintenanceDueSoonCount: num(e.attributes.maintenance_due_soon_count),
    lastFuelDate: strOrNull(e.attributes.last_fuel_date),
    lastMaintenanceDate: strOrNull(e.attributes.last_maintenance_date),
  }));

  const fuelEntries: FuelEntry[] = vehicleEntities.flatMap((e) =>
    (Array.isArray(e.attributes.fuel_entries) ? e.attributes.fuel_entries : []).map(
      (raw) => parseFuelEntry(raw as Record<string, unknown>)
    )
  );

  const maintenanceRecords: MaintenanceRecord[] = vehicleEntities.flatMap((e) =>
    (Array.isArray(e.attributes.maintenance_records) ? e.attributes.maintenance_records : []).map(
      (raw) => parseMaintenanceRecord(raw as Record<string, unknown>)
    )
  );

  const documents: GarageDocument[] = vehicleEntities.flatMap((e) =>
    (Array.isArray(e.attributes.documents) ? e.attributes.documents : []).map((raw) =>
      parseDocument(raw as Record<string, unknown>)
    )
  );

  const driversEntity = byGarageKey(hass, "drivers");
  const drivers: Driver[] = (
    Array.isArray(driversEntity?.attributes.drivers) ? driversEntity!.attributes.drivers : []
  ).map((raw: Record<string, unknown>) => ({
    id: String(raw.id),
    name: String(raw.name ?? ""),
    haUserId: strOrNull(raw.ha_user_id),
    notifyTarget: strOrNull(raw.notify_target),
  }));

  const templatesEntity = byGarageKey(hass, "maintenance_templates");
  const maintenanceTemplates: MaintenanceTemplate[] = (
    Array.isArray(templatesEntity?.attributes.templates)
      ? templatesEntity!.attributes.templates
      : []
  ).map((raw: Record<string, unknown>) => ({
    id: String(raw.id),
    name: String(raw.name ?? ""),
    basis: (raw.basis as MaintenanceTemplate["basis"]) ?? "mileage",
    intervalMiles: numOrNull(raw.interval_miles),
    intervalMonths: numOrNull(raw.interval_months),
    isCustom: Boolean(raw.is_custom),
  }));

  const vehiclesNeedingAttentionEntity = byGarageKey(hass, "vehicles_needing_attention");

  return {
    vehicles,
    drivers,
    fuelEntries,
    maintenanceTemplates,
    maintenanceRecords,
    documents,
    totalMonthlyFuelSpend: num(byGarageKey(hass, "total_monthly_fuel_spend")?.state),
    totalMonthlyMaintenanceSpend: num(
      byGarageKey(hass, "total_monthly_maintenance_spend")?.state
    ),
    vehiclesNeedingAttention: Array.isArray(vehiclesNeedingAttentionEntity?.attributes.vehicle_ids)
      ? (vehiclesNeedingAttentionEntity!.attributes.vehicle_ids as string[])
      : [],
    settings: {
      lowFuelThreshold: num(byGarageKey(hass, "settings")?.attributes.low_fuel_threshold, 0.2),
      financeSyncEnabled: Boolean(byGarageKey(hass, "settings")?.attributes.finance_sync_enabled),
      financeCategoryName: String(
        byGarageKey(hass, "settings")?.attributes.finance_category_name ?? "Transportation"
      ),
    },
  };
}

function callGarageService(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>
): Promise<unknown> {
  return hass.callService(DOMAIN, service, data);
}

export const garageApi = {
  addVehicle(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callGarageService(hass, "add_vehicle", fields);
  },
  editVehicle(hass: HomeAssistant, vehicleId: string, fields: Record<string, unknown>) {
    return callGarageService(hass, "edit_vehicle", { vehicle_id: vehicleId, ...fields });
  },
  deleteVehicle(hass: HomeAssistant, vehicleId: string) {
    return callGarageService(hass, "delete_vehicle", { vehicle_id: vehicleId });
  },
  addDriver(hass: HomeAssistant, name: string, haUserId?: string, notifyTarget?: string) {
    return callGarageService(hass, "add_driver", {
      name,
      ...(haUserId ? { ha_user_id: haUserId } : {}),
      ...(notifyTarget ? { notify_target: notifyTarget } : {}),
    });
  },
  editDriver(hass: HomeAssistant, driverId: string, fields: Record<string, unknown>) {
    return callGarageService(hass, "edit_driver", { driver_id: driverId, ...fields });
  },
  deleteDriver(hass: HomeAssistant, driverId: string) {
    return callGarageService(hass, "delete_driver", { driver_id: driverId });
  },
  // The backend proxies HA's config/auth/list (the add-on can't reach
  // HA's websocket as the user) and answers [] when HA is unreachable.
  async listHaUsers(): Promise<HaUserSummary[]> {
    const response = await fetch("api/ha_users");
    if (!response.ok) return [];
    const users = (await response.json()) as Array<{
      id: string;
      name: string;
      system_generated?: boolean;
    }>;
    return users.filter((u) => !u.system_generated).map((u) => ({ id: u.id, name: u.name }));
  },
  logFuel(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callGarageService(hass, "log_fuel", fields);
  },
  editFuelEntry(hass: HomeAssistant, entryId: string, fields: Record<string, unknown>) {
    return callGarageService(hass, "edit_fuel_entry", { entry_id: entryId, ...fields });
  },
  deleteFuelEntry(hass: HomeAssistant, entryId: string) {
    return callGarageService(hass, "delete_fuel_entry", { entry_id: entryId });
  },
  addMaintenanceTemplate(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callGarageService(hass, "add_maintenance_template", fields);
  },
  deleteMaintenanceTemplate(hass: HomeAssistant, templateId: string) {
    return callGarageService(hass, "delete_maintenance_template", { template_id: templateId });
  },
  completeMaintenance(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callGarageService(hass, "complete_maintenance", fields);
  },
  deleteMaintenanceRecord(hass: HomeAssistant, recordId: string) {
    return callGarageService(hass, "delete_maintenance_record", { record_id: recordId });
  },
  deleteDocument(hass: HomeAssistant, documentId: string) {
    return callGarageService(hass, "delete_document", { document_id: documentId });
  },
  updateSettings(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callGarageService(hass, "update_settings", fields);
  },
  async uploadDocument(
    _hass: HomeAssistant,
    vehicleId: string,
    category: string,
    file: File
  ): Promise<GarageDocument> {
    const body = new FormData();
    body.append("vehicle_id", vehicleId);
    body.append("category", category);
    body.append("file", file, file.name);
    const response = await fetch("api/upload", {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
    const payload = (await response.json()) as { document: Record<string, unknown> };
    return parseDocument(payload.document);
  },
  async uploadVehiclePhoto(_hass: HomeAssistant, vehicleId: string, file: File): Promise<string> {
    const body = new FormData();
    body.append("vehicle_id", vehicleId);
    body.append("file", file, file.name);
    const response = await fetch("api/vehicle_photo", {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
    const payload = (await response.json()) as { vehicle: { photo_path: string } };
    return payload.vehicle.photo_path;
  },
  async analyzeFuelPhoto(_hass: HomeAssistant, file: File): Promise<FuelPhotoAnalysis> {
    const body = new FormData();
    body.append("file", file, file.name);
    const response = await fetch("api/analyze_fuel_photo", {
      method: "POST",
      body,
    });
    const payload = (await response.json()) as FuelPhotoAnalysis & { error?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `Analysis failed: ${response.status}`);
    }
    return payload;
  },
  async decodeVin(_hass: HomeAssistant, vin: string): Promise<VinDecodeResult> {
    const response = await fetch(`api/decode_vin?vin=${encodeURIComponent(vin)}`);
    const payload = (await response.json()) as VinDecodeResult & { error?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `VIN decode failed: ${response.status}`);
    }
    return payload;
  },
};
