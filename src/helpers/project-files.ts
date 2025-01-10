import { type Tagged, type UnwrapTagged } from "type-fest";
import * as R from "remeda";

export type ProjectFilePath = Tagged<string, "filePath">;
export type ProjectFiles = Tagged<Record<ProjectFilePath, string>, "files">;

type BaseProjectFileModification = {
  path: ProjectFilePath;
  why: string;
};

type ModifyFileModification = BaseProjectFileModification & {
  operation: "modify";
  content: string;
};

type CreateFileModification = BaseProjectFileModification & {
  operation: "create";
  content?: string | null;
};

export type ProjectFileModification = ModifyFileModification | CreateFileModification;

export function projectFilePath(filePath: string) {
  return filePath as ProjectFilePath;
}

export function projectFilePaths(filePaths: string[]) {
  return filePaths as ProjectFilePath[];
}

export function projectFiles(files: Record<string, unknown>) {
  return files as ProjectFiles;
}

export namespace projectFiles {  
  export function filter(
    projectFiles: ProjectFiles,
    filter: (filterParams: [ProjectFilePath, string]) => boolean,
  ) {
    return R.pipe(
      projectFiles,
      R.entries(),
      R.filter(([projectFilePath, projectFileContent]) => {
        return filter([
          projectFilePath as unknown as ProjectFilePath,
          projectFileContent,
        ]);
      }),
      R.fromEntries(),
    ) as ProjectFiles;
  }
}
