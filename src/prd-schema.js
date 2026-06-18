import { ValidationError } from './validation.js';

function validateStories(stories, path) {
  if (!Array.isArray(stories)) throw new ValidationError(`${path} must be an array.`);
  for (const [index, story] of stories.entries()) {
    if (story === null || typeof story !== 'object' || Array.isArray(story)) {
      throw new ValidationError(`${path}[${index}] must be an object.`);
    }
    if (Object.hasOwn(story, 'passes') && typeof story.passes !== 'boolean') {
      throw new ValidationError(`${path}[${index}].passes must be a boolean when present.`);
    }
    if (Object.hasOwn(story, 'acceptance') && !Array.isArray(story.acceptance) && typeof story.acceptance !== 'string') {
      throw new ValidationError(`${path}[${index}].acceptance must be a string or array when present.`);
    }
  }
}

export function parseAndValidatePrdJson(raw) {
  let prd;
  try {
    prd = JSON.parse(String(raw || ''));
  } catch {
    throw new ValidationError('prd must be valid JSON.');
  }
  if (prd === null || typeof prd !== 'object' || Array.isArray(prd)) {
    throw new ValidationError('prd must be a JSON object.');
  }
  const storyKeys = ['userStories', 'stories', 'requirements', 'items', 'features', 'tasks'];
  const presentStoryKey = storyKeys.find(key => Object.hasOwn(prd, key));
  if (!presentStoryKey) throw new ValidationError('prd must include a userStories array.');
  validateStories(prd[presentStoryKey], presentStoryKey);
  return prd;
}
