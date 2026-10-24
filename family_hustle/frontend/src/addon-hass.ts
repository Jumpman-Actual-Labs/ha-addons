import type { HassEntity, HassUser, HomeAssistant } from "./ha-api";

/* The add-on's stand-in for Home Assistant's `hass` object. The panel was
 * written against HA's frontend API (see the HomeAssistant interface in
 * ha-api.ts) and still is - this implements that same interface against
 * the add-on's own backend instead:
 * - `states` comes from `api/websocket`, which pushes a fresh
 *   `hass.states`-shaped snapshot (built by the backend's states.py) on
 *   connect and after every change, exactly like HA's state_changed
 *   subscription used to keep it current.
 * - `user` arrives with the first snapshot (the backend learns it from
 *   ingress's X-Remote-User-* headers plus HA's user list for is_admin).
 * - `callService("hustle", name, data)` is `POST api/services/<name>`.
 * - `callWS` only answers the one message the panel sends,
 *   `config/auth/list`, from `api/ha_users`.
 *
 * Every URL is relative: ingress serves the add-on under
 * /api/hassio_ingress/<token>/, so the panel can't assume any fixed path. */

interface StatesMessage {
  type: "states";
  states: Record<string, HassEntity>;
  user?: HassUser | null;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

export class AddonConnection {
  private _states: Record<string, HassEntity> = {};
  private _user?: HassUser;
  private _attempt = 0;

  constructor(private readonly _onChange: (hass: HomeAssistant) => void) {}

  connect(): void {
    const url = new URL("api/websocket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as StatesMessage;
      if (msg.type !== "states") return;
      this._attempt = 0;
      this._states = msg.states;
      if (msg.user) this._user = msg.user;
      this._onChange(this.snapshot());
    };
    ws.onclose = () => {
      const delay = RECONNECT_DELAYS_MS[Math.min(this._attempt, RECONNECT_DELAYS_MS.length - 1)];
      this._attempt += 1;
      window.setTimeout(() => this.connect(), delay);
    };
  }

  /** A new object every time, like HA hands a panel a new `hass` on every
   * state change - Lit only re-renders when the property's identity
   * changes. */
  snapshot(): HomeAssistant {
    return {
      states: this._states,
      user: this._user,
      callService: (_domain, service, serviceData) => this._callService(service, serviceData ?? {}),
      callWS: <T>(msg: Record<string, unknown>) => this._callWS<T>(msg),
    };
  }

  private async _callService(
    service: string,
    data: Record<string, unknown>
  ): Promise<{ response?: Record<string, unknown> }> {
    const resp = await fetch(`api/services/${encodeURIComponent(service)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    let body: { response?: Record<string, unknown> | null; error?: string } = {};
    try {
      body = await resp.json();
    } catch {
      // Fall through to the status-based message below.
    }
    if (!resp.ok) throw new Error(body.error ?? `${service} failed (${resp.status})`);
    return { response: body.response ?? undefined };
  }

  private async _callWS<T>(msg: Record<string, unknown>): Promise<T> {
    if (msg.type !== "config/auth/list") {
      throw new Error(`${String(msg.type)} isn't available in Family Hustle`);
    }
    const resp = await fetch("api/ha_users");
    if (!resp.ok) throw new Error(`Listing users failed (${resp.status})`);
    return (await resp.json()) as T;
  }
}
