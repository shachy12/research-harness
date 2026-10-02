import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import type { RouteDeps } from '../app.ts';
import { conflict, HttpError } from './errors.ts';

const pickFolderSchema = z.object({ title: z.string().max(200).optional(), startIn: z.string().optional() });

/** Things the local machine does for the page, which a browser can't (e.g. a native folder dialog). */
export function systemRoutes({ pickFolder }: Pick<RouteDeps, 'pickFolder'>) {
  let picking = false;

  return new Hono()
    // Show the OS folder dialog on this machine; answers when the user chooses or cancels.
    .post('/pick-folder', zValidator('json', pickFolderSchema), async (c) => {
      if (picking) throw conflict('A folder dialog is already open (it may be behind this window).');
      picking = true;
      try {
        const { title = 'Choose a folder', startIn } = c.req.valid('json');
        return c.json({ path: await pickFolder({ title, startIn }) });
      } catch (err) {
        throw new HttpError(500, err instanceof Error ? err.message : 'The folder dialog failed');
      } finally {
        picking = false;
      }
    });
}
