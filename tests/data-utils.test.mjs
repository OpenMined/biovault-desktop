import test from 'node:test'
import assert from 'node:assert/strict'

import { __private__ as dataUtils } from '../src/data.js'

const { getPathBasename, buildDatasetAssetSyftUrl } = dataUtils

test('getPathBasename handles Windows and POSIX paths', () => {
	assert.equal(getPathBasename('C:\\Users\\alice\\data\\file.txt'), 'file.txt')
	assert.equal(getPathBasename('/home/alice/data/file.txt'), 'file.txt')
})

test('buildDatasetAssetSyftUrl uses basename for Windows paths', () => {
	const url = buildDatasetAssetSyftUrl(
		'user@example.com',
		'collab_genotype_dataset',
		'C:\\Users\\alice\\data\\synthetic-genotypes\\145755\\genotype.txt',
	)
	assert.equal(
		url,
		'syft://user@example.com/public/biovault/datasets/collab_genotype_dataset/assets/genotype.txt',
	)
})
