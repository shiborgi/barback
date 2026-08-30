import { z } from "zod";
import { parseDuration } from "../config/duration.ts";

const serviceIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const containerNamePattern = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;
const zonePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const pathPattern = /^\/[^\s?#]*$/;
const imagePattern =
  /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?:@sha256:[a-f0-9]{64}|:build-sha256-[a-f0-9]{16,64})$/;

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const duration = z.string().transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
    return z.NEVER;
  }
});

const imageReference = z.string().refine((value) => imagePattern.test(value), {
  message: "Image reference must use an OCI digest or build-sha256 immutable tag",
});

const healthSchema = z.union([
  strictObject({ type: z.literal("http"), path: z.string().regex(pathPattern) }),
  strictObject({ type: z.literal("exec"), command: z.array(z.string().min(1)).min(1) }),
]);

const managedRuntimeSchema = strictObject({
  mode: z.literal("managed"),
  image: imageReference,
  buildContext: z.string().min(1).optional(),
  envFile: z.string().min(1).optional(),
  mounts: z
    .array(
      strictObject({
        source: z.string().min(1),
        target: z.string().min(1),
        readOnly: z.boolean().default(false),
      }),
    )
    .default([]),
  command: z.array(z.string().min(1)).min(1).optional(),
});

const labelsSchema = z.record(z.string(), z.string().min(1));

const adoptedRuntimeSchema = strictObject({
  mode: z.literal("adopted"),
  labels: labelsSchema,
});

const runtimeSchema = z.discriminatedUnion("mode", [managedRuntimeSchema, adoptedRuntimeSchema]);

const serviceSchema = strictObject({
  role: z.enum(["gateway", "storage", "mcp"]),
  container: z.string().regex(containerNamePattern),
  dns: z.string().regex(zonePattern),
  port: z.int().min(1).max(65535),
  path: z.string().regex(pathPattern).optional(),
  required: z.boolean().default(false),
  runtime: runtimeSchema,
  health: healthSchema,
});

const dnsSchema = strictObject({
  zone: z.string().regex(zonePattern),
  container: z.string().regex(containerNamePattern),
  image: imageReference,
  ttl: duration,
  lease: duration,
});

export const stackSchema = strictObject({
  version: z.literal(1),
  stackId: z.string().regex(serviceIdPattern),
  network: z.string().regex(containerNamePattern),
  networkMode: z.literal("nat").default("nat"),
  dns: dnsSchema,
  services: z.record(z.string().regex(serviceIdPattern), serviceSchema),
}).superRefine((stack, ctx) => {
  const serviceIds = Object.keys(stack.services);
  const containers = new Map<string, string>();
  const fqdns = new Map<string, string>();

  if (stack.dns.ttl > 30_000) {
    ctx.addIssue({
      path: ["dns", "ttl"],
      code: "custom",
      message: "TTL must not exceed 30 seconds",
    });
  }
  if (stack.dns.lease <= stack.dns.ttl) {
    ctx.addIssue({
      path: ["dns", "lease"],
      code: "custom",
      message: "Lease must be longer than DNS TTL",
    });
  }
  if (stack.dns.zone !== "barback.internal") {
    ctx.addIssue({
      path: ["dns", "zone"],
      code: "custom",
      message: "DNS zone must be barback.internal",
    });
  }

  const addUnique = (map: Map<string, string>, value: string, owner: string, label: string) => {
    const previous = map.get(value);
    if (previous) {
      ctx.addIssue({
        code: "custom",
        path: ["services", owner],
        message: `Duplicate ${label} ${value} (also used by ${previous})`,
      });
    } else {
      map.set(value, owner);
    }
  };

  addUnique(containers, stack.dns.container, "dns", "container");
  addUnique(fqdns, `dns.${stack.dns.zone}`, "dns", "FQDN");

  for (const serviceId of serviceIds) {
    const service = stack.services[serviceId];
    if (!service) continue;
    addUnique(containers, service.container, serviceId, "container");
    addUnique(fqdns, service.dns, serviceId, "FQDN");

    if (serviceId === "dns") {
      ctx.addIssue({
        code: "custom",
        path: ["services", serviceId],
        message: "The DNS resolver must not be registered as an application service",
      });
    }

    if (service.dns !== stack.dns.zone && !service.dns.endsWith(`.${stack.dns.zone}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["services", serviceId, "dns"],
        message: `Name must be inside ${stack.dns.zone}`,
      });
    }

    if (service.role === "gateway") {
      if (serviceId !== "barback" || service.dns !== stack.dns.zone) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId],
          message: "Gateway service must be barback at the stack zone",
        });
      }
      if (service.path !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId, "path"],
          message: "Gateway must not define an MCP path",
        });
      }
    }
    if (service.role === "storage") {
      if (serviceId !== "valkey" || service.dns !== `valkey.${stack.dns.zone}`) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId],
          message: "Storage service must be valkey at valkey.<zone>",
        });
      }
      if (service.path !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId, "path"],
          message: "Storage must not define an MCP path",
        });
      }
    }
    if (service.role === "mcp") {
      if (service.dns !== `${serviceId}.mcp.${stack.dns.zone}`) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId, "dns"],
          message: "MCP name must be <service-id>.mcp.<zone>",
        });
      }
      if (!service.path) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceId, "path"],
          message: "MCP service requires a path",
        });
      }
    }

    if (service.runtime.mode === "adopted") {
      const labels = service.runtime.labels;
      const expected = {
        "io.shiborgi.barback.stack": stack.stackId,
        "io.shiborgi.barback.service": serviceId,
        "io.shiborgi.barback.role": service.role,
      };
      for (const [name, value] of Object.entries(expected)) {
        if (labels[name] !== value) {
          ctx.addIssue({
            code: "custom",
            path: ["services", serviceId, "runtime", "labels", name],
            message: `Adopted service requires label ${name}=${value}`,
          });
        }
      }
    }
  }

  if (!stack.services.barback) {
    ctx.addIssue({ code: "custom", path: ["services"], message: "Manifest must define barback" });
  } else if (stack.services.barback.role !== "gateway") {
    ctx.addIssue({
      code: "custom",
      path: ["services", "barback", "role"],
      message: "barback must have the gateway role",
    });
  }
  if (!stack.services.valkey) {
    ctx.addIssue({ code: "custom", path: ["services"], message: "Manifest must define valkey" });
  } else if (stack.services.valkey.role !== "storage") {
    ctx.addIssue({
      code: "custom",
      path: ["services", "valkey", "role"],
      message: "valkey must have the storage role",
    });
  }
});

export type StackConfig = z.infer<typeof stackSchema>;
export type StackService = StackConfig["services"][string];
export type ManagedRuntime = z.infer<typeof managedRuntimeSchema>;
export type AdoptedRuntime = z.infer<typeof adoptedRuntimeSchema>;
