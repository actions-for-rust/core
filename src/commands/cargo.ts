import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as http from '@actions/http-client';
import * as io from '@actions/io';
import * as path from 'path';
import { getErrorMessage } from '../utils/errors';

export async function resolveVersion(crate: string): Promise<string> {
    const url = `https://crates.io/api/v1/crates/${crate}`;
    const client = new http.HttpClient(
        '@actions-for-rust (https://github.com/actions-for-rust/)',
    );

    const resp = await client.getJson<{ crate: { newest_version: string } }>(
        url,
    );
    if (resp.result == null) {
        throw new Error('Unable to fetch latest crate version');
    }

    return resp.result['crate']['newest_version'];
}

export class Cargo {
    private readonly path: string;

    private constructor(path: string) {
        this.path = path;
    }

    public static async get(): Promise<Cargo> {
        try {
            const path = await io.which('cargo', true);

            return new Cargo(path);
        } catch (error) {
            core.error(
                'cargo is not installed by default for some virtual environments, \
see https://help.github.com/en/articles/software-in-virtual-environments-for-github-actions',
            );
            core.error(
                'To install it, use this action: https://github.com/actions-for-rust/toolchain',
            );

            throw error;
        }
    }

    /**
     * Executes `cargo install ${program}`.
     *
     * TODO: Caching ability implementation is blocked,
     * see https://github.com/actions-rs/core/issues/31
     * As for now it acts just like an stub and simply installs the program
     * on each call.
     *
     * `version` argument could be either actual program version or `"latest"` string,
     * which can be provided by user input.
     *
     * If `version` is `undefined` or `"latest"`, this method could call the Crates.io API,
     * fetch the latest version and search for it in cache.
     * TODO: Actually implement this.
     *
     * ## Returns
     *
     * Path to the installed program.
     * As the $PATH should be already tuned properly at this point,
     * returned value at the moment is simply equal to the `program` argument.
     */
    public async installCached(
        program: string,
        version?: string,
        primaryKey?: string,
        restoreKeys?: string[],
    ): Promise<string> {
        let sVersion = version ?? 'latest';
        if (sVersion === 'latest') {
            sVersion = await resolveVersion(program);
        }
        if (primaryKey) {
            restoreKeys = restoreKeys || [];
            const paths = [path.join(path.dirname(this.path), program)];
            const programKey = `${program}-${sVersion}-${primaryKey}`;
            const programRestoreKeys = restoreKeys.map(
                (key) => `${program}-${sVersion}-${key}`,
            );
            const cacheKey = await cache.restoreCache(
                paths,
                programKey,
                programRestoreKeys,
            );
            if (cacheKey) {
                core.info(
                    `Using cached \`${program}\` with version ${sVersion}`,
                );
                return program;
            } else {
                const res = await this.install(program, version);
                try {
                    core.info(`Caching \`${program}\` with key ${programKey}`);
                    await cache.saveCache(paths, programKey);
                } catch (error) {
                    if (error instanceof cache.ValidationError) {
                        throw error;
                    } else if (error instanceof cache.ReserveCacheError) {
                        core.info(error.message);
                    } else {
                        core.warning(getErrorMessage(error));
                    }
                }
                return res;
            }
        } else {
            return await this.install(program, version);
        }
    }

    async install(program: string, version?: string): Promise<string> {
        const args = ['install'];
        if (version && version != 'latest') {
            args.push('--version');
            args.push(version);
        }
        args.push(program);

        try {
            core.startGroup(`Installing "${program} = ${version || 'latest'}"`);
            await this.call(args);
        } finally {
            core.endGroup();
        }

        return program;
    }

    /**
     * Find the cargo sub-command or install it
     */
    public async findOrInstall(
        program: string,
        version?: string,
    ): Promise<string> {
        try {
            return await io.which(program, true);
        } catch (error) {
            core.info(`${program} is not installed, installing it now`);
        }

        return await this.installCached(program, version);
    }

    public async call(
        args: string[],
        options?: exec.ExecOptions,
    ): Promise<number> {
        return await exec.exec(this.path, args, options);
    }
}
