import {
  generateId,
  isAbortError,
  safeValidateTypes,
  type FetchFunction,
} from "@ai-sdk/provider-utils";
import {
  asSchema,
  isDeepEqualData,
  parsePartialJson,
  type DeepPartial,
  type Schema,
} from "@ai-sdk/ui-utils";
import { SvelteMap } from "svelte/reactivity";
import z from "zod";

export type Experimental_ObjecClienttOptions<RESULT> = {
  /**
   * The API endpoint. It should stream JSON that matches the schema as chunked text.
   */
  api: string;

  /**
   * A Zod schema that defines the shape of the complete object.
   */
  schema: z.Schema<RESULT, z.ZodTypeDef, any> | Schema<RESULT>;

  /**
   * An unique identifier. If not provided, a random one will be
   * generated. When provided, the `useObject` hook with the same `id` will
   * have shared states across components.
   */
  id?: string;

  /**
   * An optional value for the initial object.
   */
  initialValue?: DeepPartial<RESULT>;

  /**
   * Custom fetch implementation. You can use it as a middleware to intercept requests,
   * or to provide a custom fetch implementation for e.g. testing.
   */
  fetch?: FetchFunction;

  /**
   * Callback that is called when the stream has finished.
   */
  onFinish?: (event: {
    /**
     * The generated object (typed according to the schema).
     * Can be undefined if the final object does not match the schema.
     */
    object: RESULT | undefined;

    /**
     * Optional error object. This is e.g. a TypeValidationError when the final object does not match the schema.
     */
    error: Error | undefined;
  }) => Promise<void> | void;

  /**
   * Callback function to be called when an error is encountered.
   */
  onError?: (error: Error) => void;

  /**
   * Additional HTTP headers to be included in the request.
   */
  headers?: Record<string, string> | Headers;
};

export class ObjectClient<RESULT, INPUT = any> {
  #options: Experimental_ObjecClienttOptions<RESULT> = {} as any;
  readonly #api = $derived(this.#options.api ?? "/api/completion");
  readonly #id = $derived(this.#options.id ?? generateId());
  readonly #objects = new SvelteMap<string, DeepPartial<RESULT> | undefined>();
  #error = $state<Error>();
  #loading = $state(false);
  #abortController: AbortController | undefined;

  /**
   * The current value for the generated object. Updated as the API streams JSON chunks.
   */
  get object(): DeepPartial<RESULT> | undefined {
    return this.#objects.get(this.#id);
  }

  /** The error object of the API request */
  get error() {
    return this.#error;
  }

  /**
   * Flag that indicates whether an API request is in progress.
   */
  get loading() {
    return this.#loading;
  }

  constructor(options: Experimental_ObjecClienttOptions<RESULT>) {
    this.#options = options;
    this.#objects.set(this.#id, options.initialValue);
  }

  /**
   * Abort the current request immediately, keep the current partial object if any.
   */
  stop = () => {
    try {
      this.#abortController?.abort();
    } catch {
      // ignore
    } finally {
      this.#loading = false;
      this.#abortController = undefined;
    }
  };

  /**
   * Calls the API with the provided input as JSON body.
   */
  submit = async (input: INPUT) => {
    try {
      this.#objects.set(this.#id, undefined); // reset the data
      this.#loading = true;
      this.#error = undefined;

      this.#abortController = new AbortController();

      const actualFetch = this.#options.fetch ?? fetch;
      const response = await actualFetch(this.#api, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.#options.headers,
        },
        signal: this.#abortController.signal,
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        throw new Error(
          (await response.text()) ?? "Failed to fetch the response.",
        );
      }

      if (response.body == null) {
        throw new Error("The response body is empty.");
      }

      let accumulatedText = "";
      let latestObject: DeepPartial<RESULT> | undefined = undefined;

      await response.body.pipeThrough(new TextDecoderStream()).pipeTo(
        new WritableStream<string>({
          write: (chunk) => {
            accumulatedText += chunk;

            const { value } = parsePartialJson(accumulatedText);
            const currentObject = value as DeepPartial<RESULT>;

            if (!isDeepEqualData(latestObject, currentObject)) {
              latestObject = currentObject;

              this.#objects.set(this.#id, currentObject);
            }
          },

          close: () => {
            this.#loading = false;
            this.#abortController = undefined;

            if (this.#options.onFinish != null) {
              const validationResult = safeValidateTypes({
                value: latestObject,
                // This is a lot of types, but it's creating an infinite recursion issue in the type system
                // so the casts are necessary to tell it to quit trying
                schema: asSchema<RESULT>(
                  this.#options.schema as Schema<RESULT>,
                ) as Schema<RESULT>,
              });

              this.#options.onFinish(
                validationResult.success
                  ? { object: validationResult.value, error: undefined }
                  : { object: undefined, error: validationResult.error },
              );
            }
          },
        }),
      );
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      const coalescedError =
        error instanceof Error ? error : new Error(String(error));
      if (this.#options.onError) {
        this.#options.onError(coalescedError);
      }

      this.#loading = false;
      this.#error = coalescedError;
    }
  };
}
