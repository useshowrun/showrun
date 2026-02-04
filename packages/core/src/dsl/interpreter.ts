import type { RunContext, RunResult, AuthConfig } from '../types.js';
import type { DslStep, RunFlowOptions, RunFlowResult } from './types.js';
import { validateFlow } from './validation.js';
import { executeStep } from './stepHandlers.js';
import { resolveTemplates } from './templating.js';
import type { StepContext } from './stepHandlers.js';
import {
  OnceCache,
  AuthFailureMonitor,
  AuthGuardChecker,
  setupBrowserAuthMonitoring,
  shouldSkipStep,
  getOnceSteps,
  type StepOutput,
} from '../authResilience.js';
import type { NetworkCaptureApi, NetworkEntrySerializable } from '../networkCapture.js';
import { evaluateCondition, conditionToString } from './conditions.js';

/**
 * Capture the delta of vars and collectibles produced by a step,
 * along with any network entries referenced by new vars (for network_find caching)
 */
function captureStepOutputs(
  varsBefore: Record<string, unknown>,
  varsAfter: Record<string, unknown>,
  collectiblesBefore: Record<string, unknown>,
  collectiblesAfter: Record<string, unknown>,
  networkCapture?: NetworkCaptureApi
): StepOutput {
  const newVars: Record<string, unknown> = {};
  const newCollectibles: Record<string, unknown> = {};
  const networkEntries: NetworkEntrySerializable[] = [];

  // Find vars that were added or modified
  for (const [key, value] of Object.entries(varsAfter)) {
    if (!(key in varsBefore) || varsBefore[key] !== value) {
      newVars[key] = value;

      // If the value looks like a request ID (string starting with 'req-'),
      // export the network entry for caching
      if (networkCapture && typeof value === 'string' && value.startsWith('req-')) {
        const entry = networkCapture.exportEntry(value);
        if (entry) {
          networkEntries.push(entry);
        }
      }
    }
  }

  // Find collectibles that were added or modified
  for (const [key, value] of Object.entries(collectiblesAfter)) {
    if (!(key in collectiblesBefore) || collectiblesBefore[key] !== value) {
      newCollectibles[key] = value;
    }
  }

  return {
    vars: newVars,
    collectibles: newCollectibles,
    networkEntries: networkEntries.length > 0 ? networkEntries : undefined,
  };
}

/**
 * Extended options for running a flow with auth resilience
 */
export interface RunFlowOptionsWithAuth extends RunFlowOptions {
  inputs?: Record<string, unknown>;
  auth?: AuthConfig;
  sessionId?: string;
  profileId?: string;
  /**
   * Directory for profile cache storage (typically the pack directory)
   */
  cacheDir?: string;
  /**
   * Secrets for template resolution ({{secret.NAME}})
   */
  secrets?: Record<string, string>;
}

/**
 * Redacts secret values from an object before logging.
 * Replaces any occurrence of secret values with [REDACTED].
 */
function redactSecrets<T>(obj: T, secretValues: string[]): T {
  if (secretValues.length === 0) return obj;

  let str = JSON.stringify(obj);
  for (const value of secretValues) {
    // Only redact secrets that are at least 3 characters long
    if (value && value.length >= 3) {
      // Escape special regex characters in the secret value
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      str = str.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }
  try {
    return JSON.parse(str) as T;
  } catch {
    return obj;
  }
}

/**
 * Runs a flow of DSL steps sequentially with auth resilience support
 */
export async function runFlow(
  ctx: RunContext,
  steps: DslStep[],
  options?: RunFlowOptionsWithAuth
): Promise<RunFlowResult> {
  const startTime = Date.now();
  const stopOnError = options?.stopOnError ?? true;
  const inputs = options?.inputs ?? {};
  const authConfig = options?.auth;
  const sessionId = options?.sessionId;
  const profileId = options?.profileId;
  const cacheDir = options?.cacheDir;
  const secrets = options?.secrets ?? {};

  // Get secret values for redaction (only values >= 3 chars)
  const secretValues = Object.values(secrets).filter((v) => v && v.length >= 3);

  // Validate flow before execution
  validateFlow(steps);

  const collectibles: Record<string, unknown> = {};
  const vars: Record<string, unknown> = {};

  // Initialize variable context (including secrets for templating)
  const variableContext = {
    inputs,
    vars,
    secrets,
  };

  // Initialize auth resilience components: load persisted "once" cache when sessionId/profileId provided
  const onceCache =
    sessionId || profileId
      ? OnceCache.fromDisk(sessionId, profileId, cacheDir)
      : new OnceCache();
  let authMonitor: AuthFailureMonitor | null = null;
  let authGuard: AuthGuardChecker | null = null;
  let authRecoveriesUsed = 0;

  const stepContext: StepContext = {
    page: ctx.page,
    collectibles,
    vars,
    inputs,
    networkCapture: ctx.networkCapture,
    authMonitor: authMonitor ?? undefined,
  };

  if (authConfig?.authPolicy) {
    authMonitor = new AuthFailureMonitor(authConfig.authPolicy);
    if (authMonitor.isEnabled()) {
      setupBrowserAuthMonitoring(ctx.page, authMonitor, ctx.logger);
    }
  }

  if (authConfig?.authGuard) {
    authGuard = new AuthGuardChecker(authConfig.authGuard);
    // Run auth guard check if enabled (before main steps)
    if (authGuard.isEnabled()) {
      const authValid = await authGuard.checkAuth(ctx.page);
      if (!authValid) {
        // Auth guard failed - run setup steps (once steps) before main flow
        const onceSteps = getOnceSteps(steps);
        if (onceSteps.length > 0) {
          await executeStepsWithRecovery(
            ctx,
            stepContext,
            variableContext,
            onceSteps,
            onceCache,
            authMonitor,
            sessionId,
            profileId,
            stopOnError,
            authRecoveriesUsed
          );
        }
      }
    }
  }

  let stepsExecuted = 0;

  try {
    // Execute steps sequentially
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex];
      const stepStartTime = Date.now();
      const stepLabel = step.label || step.id;

      // Check if step should be skipped due to "once" cache
      if (shouldSkipStep(step, onceCache, sessionId, profileId)) {
        // Determine scope and restore cached outputs
        const scope = step.once === 'session' && sessionId ? 'session' : 'profile';
        const cachedOutputs = onceCache.getOutputs(step.id, scope);

        // Restore cached vars and collectibles
        if (cachedOutputs) {
          Object.assign(vars, cachedOutputs.vars);
          Object.assign(collectibles, cachedOutputs.collectibles);

          // Restore network entries into the capture buffer
          if (cachedOutputs.networkEntries && ctx.networkCapture) {
            for (const entry of cachedOutputs.networkEntries) {
              ctx.networkCapture.importEntry(entry);
            }
          }
        }

        ctx.logger.log({
          type: 'step_skipped',
          data: {
            stepId: step.id,
            type: step.type,
            reason: 'once_already_executed',
            restoredVars: cachedOutputs ? Object.keys(cachedOutputs.vars) : [],
            restoredCollectibles: cachedOutputs ? Object.keys(cachedOutputs.collectibles) : [],
          },
        });
        stepsExecuted++;
        continue;
      }

      // Check if step should be skipped due to skip_if condition
      if (step.skip_if) {
        try {
          const shouldSkip = await evaluateCondition(
            { page: ctx.page, vars },
            step.skip_if
          );
          if (shouldSkip) {
            ctx.logger.log({
              type: 'step_skipped',
              data: {
                stepId: step.id,
                type: step.type,
                reason: 'condition_met',
                condition: conditionToString(step.skip_if),
              },
            });
            stepsExecuted++;
            continue;
          }
        } catch (conditionError) {
          // Log condition evaluation error but continue with step execution
          console.warn(
            `[interpreter] Error evaluating skip_if for step ${step.id}:`,
            conditionError
          );
        }
      }

      // Resolve templates in step params before execution
      const resolvedStep = {
        ...step,
        params: resolveTemplates(step.params, variableContext),
      } as DslStep;

      // Log step start with resolved params (redact secrets for safe logging)
      const logParams = redactSecrets(JSON.parse(JSON.stringify(resolvedStep.params)), secretValues);
      ctx.logger.log({
        type: 'step_started',
        data: {
          stepId: step.id,
          type: step.type,
          label: stepLabel,
          params: logParams,
        },
      });

      try {
        // Snapshot state before step execution (for capturing outputs)
        const varsBefore = resolvedStep.once ? { ...vars } : {};
        const collectiblesBefore = resolvedStep.once ? { ...collectibles } : {};

        // Apply step-level timeout if specified
        const timeoutMs = resolvedStep.timeoutMs;
        let stepPromise = executeStep(stepContext, resolvedStep);

        if (timeoutMs) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Step timeout after ${timeoutMs}ms`));
            }, timeoutMs);
          });
          stepPromise = Promise.race([stepPromise, timeoutPromise]);
        }

        await stepPromise;
        stepsExecuted++;

        // Mark step as executed if it has "once" flag, with captured outputs
        if (resolvedStep.once) {
          const scope = resolvedStep.once === 'session' && sessionId ? 'session' : 'profile';
          const stepOutputs = captureStepOutputs(varsBefore, vars, collectiblesBefore, collectibles, ctx.networkCapture);
          onceCache.markExecuted(step.id, scope, stepOutputs);
        }

        // Log step finish
        const stepDuration = Date.now() - stepStartTime;
        ctx.logger.log({
          type: 'step_finished',
          data: {
            stepId: step.id,
            type: step.type,
            label: stepLabel,
            durationMs: stepDuration,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for auth failure and attempt recovery
        if (authMonitor?.isEnabled()) {
          const stepFailures = authMonitor.getFailuresForStep(step.id);
          if (stepFailures.length > 0) {
            // Auth failure detected for this step - attempt recovery
            const latestFailure = stepFailures[stepFailures.length - 1];
            authRecoveriesUsed++;
            const maxRecoveries = authMonitor.getMaxRecoveries();

            if (authRecoveriesUsed > maxRecoveries) {
              // Recovery exhausted
              ctx.logger.log({
                type: 'auth_recovery_exhausted',
                data: {
                  url: latestFailure.url,
                  status: latestFailure.status,
                  maxRecoveries,
                },
              });
              throw new Error(
                `Auth recovery exhausted after ${maxRecoveries} attempt(s). Last failure: ${latestFailure.status} at ${latestFailure.url}`
              );
            }

            // Attempt recovery
            ctx.logger.log({
              type: 'auth_recovery_started',
              data: {
                recoveryAttempt: authRecoveriesUsed,
                maxRecoveries,
              },
            });

            // Clear once cache based on pack scope (sessionId/profileId)
            // If sessionId is provided, clear session cache; otherwise clear profile cache
            // Clear both if both are provided (to be safe)
            if (sessionId && profileId) {
              onceCache.clearAll();
            } else if (sessionId) {
              onceCache.clear('session');
            } else if (profileId) {
              onceCache.clear('profile');
            } else {
              // No scope provided - clear both to be safe
              onceCache.clearAll();
            }

            // Rerun once steps (setup)
            const onceSteps = getOnceSteps(steps);
            if (onceSteps.length > 0) {
              await executeStepsWithRecovery(
                ctx,
                stepContext,
                variableContext,
                onceSteps,
                onceCache,
                authMonitor,
                sessionId,
                profileId,
                stopOnError,
                authRecoveriesUsed
              );
            }

            // Clear the failure record for this step (to allow retry)
            authMonitor.clearFailuresForStep(step.id);

            // Wait for cooldown if configured
            const cooldownMs = authMonitor.getCooldownMs();
            if (cooldownMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, cooldownMs));
            }

            // Retry the failed step (up to maxStepRetryAfterRecovery times)
            const maxRetries = authMonitor.getMaxStepRetries();
            const timeoutMs = resolvedStep.timeoutMs; // Capture timeoutMs for retry loop
            let retrySuccess = false;
            for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
              try {
                // Snapshot state before retry (for capturing outputs)
                const retryVarsBefore = resolvedStep.once ? { ...vars } : {};
                const retryCollectiblesBefore = resolvedStep.once ? { ...collectibles } : {};

                // Update current step ID for monitoring
                stepContext.currentStepId = step.id;
                setupBrowserAuthMonitoring(ctx.page, authMonitor, ctx.logger, step.id);

                let retryPromise = executeStep(stepContext, resolvedStep);
                if (timeoutMs) {
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    setTimeout(() => {
                      reject(new Error(`Step timeout after ${timeoutMs}ms`));
                    }, timeoutMs);
                  });
                  retryPromise = Promise.race([retryPromise, timeoutPromise]);
                }

                await retryPromise;
                retrySuccess = true;
                stepsExecuted++;

                // Mark step as executed if it has "once" flag, with captured outputs
                if (resolvedStep.once) {
                  const scope = resolvedStep.once === 'session' && sessionId ? 'session' : 'profile';
                  const stepOutputs = captureStepOutputs(retryVarsBefore, vars, retryCollectiblesBefore, collectibles, ctx.networkCapture);
                  onceCache.markExecuted(step.id, scope, stepOutputs);
                }

                // Log successful retry
                const stepDuration = Date.now() - stepStartTime;
                ctx.logger.log({
                  type: 'step_finished',
                  data: {
                    stepId: step.id,
                    type: step.type,
                    label: stepLabel,
                    durationMs: stepDuration,
                  },
                });

                ctx.logger.log({
                  type: 'auth_recovery_finished',
                  data: {
                    recoveryAttempt: authRecoveriesUsed,
                    success: true,
                  },
                });
                break; // Success - exit retry loop
              } catch (retryError) {
                // Retry failed - check if we have more attempts
                if (retryAttempt === maxRetries - 1) {
                  // All retries exhausted
                  ctx.logger.log({
                    type: 'auth_recovery_finished',
                    data: {
                      recoveryAttempt: authRecoveriesUsed,
                      success: false,
                    },
                  });
                  throw retryError;
                }
                // Wait before next retry
                if (cooldownMs > 0) {
                  await new Promise((resolve) => setTimeout(resolve, cooldownMs));
                }
              }
            }

            if (retrySuccess) {
              continue; // Step succeeded after recovery - continue to next step
            }
          }
        }

        // Log error
        ctx.logger.log({
          type: 'error',
          data: {
            error: errorMessage,
            stepId: step.id,
            type: step.type,
            label: stepLabel,
          },
        });

        // Handle optional steps
        if (resolvedStep.optional) {
          // Optional step failed - log and continue
          stepsExecuted++;
          continue;
        }

        // Handle per-step error behavior
        const errorBehavior = resolvedStep.onError || (stopOnError ? 'stop' : 'continue');

        if (errorBehavior === 'continue') {
          // Continue to next step
          stepsExecuted++;
          continue;
        }

        // Capture artifacts on error if available
        if (ctx.artifacts) {
          try {
            await ctx.artifacts.saveScreenshot(`error-${step.id}`);
            const html = await ctx.page.content();
            await ctx.artifacts.saveHTML(`error-${step.id}`, html);
          } catch (artifactError) {
            // Ignore artifact save errors, but log them
            console.error('Failed to save artifacts:', artifactError);
          }
        }

        // Stop on error (default behavior)
        throw error;
      }
    }

    const durationMs = Date.now() - startTime;
    const finalUrl = ctx.page.url();

    return {
      collectibles,
      meta: {
        url: finalUrl,
        durationMs,
        stepsExecuted,
        stepsTotal: steps.length,
      },
    };
  } catch (error) {
    throw error;
  } finally {
    if (sessionId || profileId) {
      onceCache.persist(sessionId, profileId, cacheDir);
    }
  }
}

/**
 * Helper to execute steps with recovery support (for rerunning once steps)
 */
async function executeStepsWithRecovery(
  ctx: RunContext,
  stepContext: StepContext,
  variableContext: { inputs: Record<string, unknown>; vars: Record<string, unknown> },
  steps: DslStep[],
  onceCache: OnceCache,
  authMonitor: AuthFailureMonitor | null,
  sessionId: string | undefined,
  profileId: string | undefined,
  stopOnError: boolean,
  authRecoveriesUsed: number
): Promise<void> {
  const { vars } = variableContext;
  const collectibles = stepContext.collectibles;
  const networkCapture = stepContext.networkCapture;

  for (const step of steps) {
    // Skip if already executed (shouldn't happen during recovery, but be safe)
    if (shouldSkipStep(step, onceCache, sessionId, profileId)) {
      // Restore cached outputs when skipping during recovery
      const scope = step.once === 'session' && sessionId ? 'session' : 'profile';
      const cachedOutputs = onceCache.getOutputs(step.id, scope);
      if (cachedOutputs) {
        Object.assign(vars, cachedOutputs.vars);
        Object.assign(collectibles, cachedOutputs.collectibles);

        // Restore network entries into the capture buffer
        if (cachedOutputs.networkEntries && networkCapture) {
          for (const entry of cachedOutputs.networkEntries) {
            networkCapture.importEntry(entry);
          }
        }
      }
      continue;
    }

    const resolvedStep = {
      ...step,
      params: resolveTemplates(step.params, variableContext),
    } as DslStep;

    try {
      // Snapshot state before step execution (for capturing outputs)
      const varsBefore = resolvedStep.once ? { ...vars } : {};
      const collectiblesBefore = resolvedStep.once ? { ...collectibles } : {};

      // Update current step ID and monitoring for current step
      stepContext.currentStepId = step.id;
      if (authMonitor?.isEnabled()) {
        setupBrowserAuthMonitoring(ctx.page, authMonitor, ctx.logger, step.id);
      }

      await executeStep(stepContext, resolvedStep);

      // Mark as executed with captured outputs
      if (resolvedStep.once) {
        const scope = resolvedStep.once === 'session' && sessionId ? 'session' : 'profile';
        const stepOutputs = captureStepOutputs(varsBefore, vars, collectiblesBefore, collectibles, networkCapture);
        onceCache.markExecuted(step.id, scope, stepOutputs);
      }
    } catch (error) {
      // If recovery fails during setup rerun, throw (don't retry recovery)
      if (stopOnError) {
        throw error;
      }
      // Otherwise continue
    }
  }
}
