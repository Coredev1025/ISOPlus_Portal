import { getFolder } from '../isoplus.js';
import { info, warn, error } from '../../utils/logger.js';

/**
 * Board validation rules based on label
 * Each label defines expected folder structure and attributes
 */
const labelValidationRules = {
  'Job Reporting': {
    requiredFolders: ['Jobs', 'Clients'],
    optionalFolders: ['Templates', 'Archive'],
    requiredAttributes: ['status', 'client', 'date']
  },
  'Job Planning': {
    requiredFolders: ['Projects', 'Tasks'],
    optionalFolders: ['Resources', 'Archive'],
    requiredAttributes: ['status', 'priority', 'assigned_to']
  },
  'Quotes': {
    requiredFolders: ['Active', 'Pending', 'Approved', 'Rejected'],
    optionalFolders: ['Archive', 'Templates'],
    requiredAttributes: ['status', 'client', 'amount']
  },
  'Purchase Orders': {
    requiredFolders: ['Active', 'Completed'],
    optionalFolders: ['Pending', 'Archive'],
    requiredAttributes: ['status', 'vendor', 'amount']
  },
  'NDIS': {
    requiredFolders: ['Participants', 'Service Plans'],
    optionalFolders: ['Archive', 'Reports'],
    requiredAttributes: ['participant_id', 'status']
  },
  'Aged Care': {
    requiredFolders: ['Residents', 'Care Plans'],
    optionalFolders: ['Archive', 'Reports'],
    requiredAttributes: ['resident_id', 'status']
  },
  'Default': {
    requiredFolders: [],
    optionalFolders: [],
    requiredAttributes: []
  }
};

/**
 * Validate board structure based on its label
 * @param {string} workspaceId - Workspace ID
 * @param {string} boardId - Board ID
 * @param {string} label - Board label
 * @returns {Promise<Object>} Validation result
 */
export async function validateBoard(workspaceId, boardId, label) {
  const validationErrors = [];
  
  try {
    info('Sync-Validator', 'Starting board validation', { workspaceId, boardId, label });
    
    // Get validation rules for the label, or use default
    const rules = labelValidationRules[label] || labelValidationRules['Default'];
    
    // If no specific rules, consider it valid
    if (rules.requiredFolders.length === 0 && rules.requiredAttributes.length === 0) {
      info('Sync-Validator', 'No specific validation rules for label, considering valid', { label });
      return {
        isValid: true,
        errors: [],
        warnings: ['No specific validation rules defined for this label']
      };
    }
    
    // Fetch board folders
    const foldersResponse = await getFolder(workspaceId, boardId);
    
    if (foldersResponse.status !== 200) {
      throw new Error('Failed to fetch board folders for validation');
    }
    
    const folders = foldersResponse.folder || [];
    const folderNames = folders.map(f => f.name);
    
    info('Sync-Validator', 'Found folders', { 
      workspaceId, 
      boardId, 
      folderCount: folders.length,
      folderNames 
    });
    
    // Validate required folders
    for (const requiredFolder of rules.requiredFolders) {
      if (!folderNames.includes(requiredFolder)) {
        validationErrors.push(`Missing required folder: ${requiredFolder}`);
      }
    }
    
    // Check for unexpected folders (warning only)
    const expectedFolders = [...rules.requiredFolders, ...rules.optionalFolders];
    const unexpectedFolders = folderNames.filter(name => !expectedFolders.includes(name));
    
    const warnings = [];
    if (unexpectedFolders.length > 0) {
      warnings.push(`Unexpected folders found: ${unexpectedFolders.join(', ')}`);
      warn('Sync-Validator', 'Unexpected folders found', { 
        workspaceId, 
        boardId, 
        unexpectedFolders 
      });
    }
    
    // Validate attributes (would need to check actual items, for now just structure)
    // This is a simplified validation - in production you'd check actual item attributes
    
    const isValid = validationErrors.length === 0;
    
    if (isValid) {
      info('Sync-Validator', 'Board validation successful', { 
        workspaceId, 
        boardId, 
        label 
      });
    } else {
      error('Sync-Validator', 'Board validation failed', { 
        workspaceId, 
        boardId, 
        label,
        errors: validationErrors 
      });
    }
    
    return {
      isValid,
      errors: validationErrors,
      warnings
    };
    
  } catch (err) {
    error('Sync-Validator', 'Board validation error', { 
      workspaceId, 
      boardId, 
      label,
      error: err.message 
    });
    
    return {
      isValid: false,
      errors: [`Validation failed: ${err.message}`],
      warnings: []
    };
  }
}

/**
 * Get validation rules for a label
 * @param {string} label - Board label
 * @returns {Object} Validation rules
 */
export function getValidationRulesForLabel(label) {
  return labelValidationRules[label] || labelValidationRules['Default'];
}

